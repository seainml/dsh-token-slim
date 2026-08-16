# 调研报告：大模型编码代理会话的 Token 优化技术

> 面向 DeepSeek Harness（DSH）插件生态的设计前调研。
> 本报告回答三个问题：**token 为什么贵**、**主流优化手段有哪些**、**哪些手段可以在 DSH 的 Cordis 扩展点上落地为插件**。

---

## 1. 摘要

在 agentic 编码工具中，token 消耗不再是一次性输入，而是"每个进入上下文的 token，会在后续每一轮被反复重读"。Anthropic 官方博客《Maximizing the value of your Claude Code sessions》把会话成本归结为三个变量：

```
单会话成本 ≈ Σ(进入上下文的 token 数) × (它们在上下文中停留的轮数) × 每轮重读价格(缓存/全价)
```

降低成本的路径因此分为三类：

1. **让每个 token 更便宜** —— 利用缓存（0.1x 读价）、选对模型与 effort 级别（避免中途切换破坏缓存键）；
2. **让进入上下文的 token 更少** —— 任务间 `/clear`、`@` 引用文件、噪声命令加 quiet flags、压缩工具输出、只读必要文件；
3. **让 token 停留更短** —— `/compact`、`/rewind`、`/autocompact`、把噪声任务交给子代理。

学术界（LLMLingua 系列、Selective Context、记忆压缩/Rate-Distortion 视角、KV cache 压缩）与工程界（Claude Code hooks 生态的 rtk / squeez / pith、通用 prompt 压缩中间件 leanctx / twotrim）从不同角度提供了可借鉴的机制。**本报告的核心结论是：DSH 已经原生具备压缩骨架（tokenMeter + compaction + toolResultPruner），但缺少三层能力——内容感知的"噪声行"过滤、面向用户的上下文健康度审计、以及选择性上下文保留策略。** 这正是本仓库插件套件（`dsh-token-slim`）要补齐的部分，详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 2. Claude Code 官方技巧逐条解读

原文：[Maximizing the value of your Claude Code sessions | Claude by Anthropic](https://claude.com/blog/maximizing-the-value-of-your-claude-code-sessions)

### 2.1 成本模型：一个 token 的价格由什么决定

| 因素 | 说明 | 相对价格 |
| --- | --- | --- |
| 模型规模 | 更大的模型在输入/输出上做更多计算 | 相乘系数 |
| 输入 vs 输出 | 解码（decode）逐 token 串行执行 | 输出 ≈ 5x 输入 |
| 缓存读 | 请求前缀与服务器刚见过的完全相同，直接读状态 | **0.1x** 输入价 |
| 缓存写 | 首次把状态写进缓存 | 至多 2x 输入价 |

**关键机制 —— prompt cache 的匹配规则**：请求按固定顺序组装（工具定义 → 系统提示 → 会话历史），缓存必须"从头开始"完全匹配。**任何靠近前缀的变化都会使后续全部内容重新全价 prefill**。缓存键包含：

- **模型**（`/model`，含 plan mode 的模型切换）
- **effort 级别**（`/effort`）
- **fast mode**
- **压缩后的历史**（`/compact` 之后前缀变化）
- **时间**（订阅 1 小时 / API key 5 分钟过期，`ENABLE_PROMPT_CACHING_1H=1` 可延长到 1 小时）

由此导出第一条工程铁律：**模型与 effort 的决定必须发生在会话开始前**，中途切换 = 整段历史重新全价 prefill。

### 2.2 六大技巧与原理

| # | 官方技巧 | 优化类别 | 原理 |
| --- | --- | --- | --- |
| 1 | **任务间 `/clear`** | 让 token 更少 + 停留更短 | 上一任务的上下文（文件、命令输出）不再随新任务每轮重读 |
| 2 | **开始前定 `/model` 与 `/effort`** | 让 token 更便宜 | 中途切换破坏缓存键，整段历史重新全价 prefill |
| 3 | **`@`-mention 文件** | 让 token 更少 | 文件直接附着在首条消息，省掉一次 Read 调用甚至一轮搜索 |
| 4 | **噪声命令加 quiet flags，或交给子代理** | 让 token 更少 | 命令输出与会话绑定并持续到会话结束；`--reporter=dot`、`tail` 等可省数百行/每轮 |
| 5 | **新会话里跑一次 `/context`** | 让 token 更少 | 查看启动时已加载的内容（CLAUDE.md、MCP 工具定义），砍掉无关项 |
| 6 | **离开键盘前 `/compact`** | 让 token 更便宜 | 缓存 1 小时过期；在缓存有效期内写摘要远便宜于过期后全量重算 |

### 2.3 附带技巧（原文 Tips 汇总）

- **`/rewind` 优于 `/compact`**：只想砍掉最近几轮时，rewind 只截断尾部，前面全部仍命中缓存（0 成本）；compact 重写整个会话，总有一定成本。
- **`/autocompact 200k`**：1M 上下文模型上把自动压缩安全网调回 200k 阈值。
- **`MAX_THINKING_TOKENS=0`**：纯体力活会话关闭思考 token（Fable 5 除外），是低于 `/effort low` 的一档。
- **`/loop` 放独立终端**：loop 每一轮都携带所在会话的整段上下文；若距上一轮超过 1 小时还会缓存未命中。
- **子代理**：拥有独立上下文窗口，只把最终答案带回主会话；噪声活（翻日志、批量扫描）交出去；重复的噪声任务可以定义 `model: haiku` 的专用子代理。
- **CLAUDE.md 精简**：只放具体指令；工作流类指令放进 skill（按需加载）；不需要的 MCP server 用 `/mcp` 关掉。
- **`BASH_MAX_OUTPUT_LENGTH`**：>30k 字符的输出自动落盘，上下文只保留预览与路径——但 30k 以下"400 行 PASS"这类输出仍然整段进上下文。
- **常用命令写进 CLAUDE.md**（带 quiet flags），如 `npx vitest run <file> --reporter=dot`——每个会话省一轮和几百行输出。

**一句话总结**：缓存使"重读历史"很便宜，但绝不免费；优化目标是让**每次进入上下文的都是高价值内容**。

---

## 3. 学术界方案调研

### 3.1 Prompt 压缩（把进入上下文的 token 变少）

- **Selective Context** —— *Compressing Context to Enhance Inference Efficiency of Large Language Models*，[arXiv:2310.06201](https://arxiv.org/abs/2310.06201)：用一个小模型计算 token 的自信息（self-information），丢弃信息量低、不参与局部关联的 token，而非整句删除；压缩率可到 ~2x，且在下游任务上保持甚至提升表现。
- **LLMLingua** —— *LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models*，[arXiv:2310.05736](https://arxiv.org/abs/2310.05736)：用训练好的小模型做**困惑度感知**的迭代压缩，可到 20x 压缩率而性能损失很小；针对指令保留关键 token。
- **LongLLMLingua** —— [arXiv:2310.06839](https://arxiv.org/abs/2310.06839)：面向长上下文场景，把"问题感知压缩"（question-aware）应用到检索到的文档，显著改善长上下文基准。
- **LLMLingua-2** —— [arXiv:2403.12968](https://arxiv.org/abs/2403.12968)：把压缩建模为**逐 token 分类**（保留/删除），并引入"信息保真度"训练数据蒸馏，比一代更稳、更可推理。
- **文档字符串压缩** —— *Less is More: DocString Compression in Code Generation*，[arXiv:2410.22793](https://arxiv.org/abs/2410.22793)：对代码上下文里的文档字符串做专门压缩（对编码代理尤有参考价值）。

**对本项目的启示**：完整的 LLM 级压缩（小模型评分）在编码代理里属于"重武器"——延迟高、需额外模型。更务实的工程化形态是**规则驱动的行级/块级过滤**（见 rtk / squeez），以及把 LLMLingua 的思路降维成"保留高信息行（错误、差异、结论）、丢弃低信息行（进度、PASS、重复）"。

### 3.2 记忆压缩 / 代理上下文管理（让 token 停留更短、保留更有价值）

- **What to Keep, What to Forget: A Rate–Distortion View of Memory Compaction in LLMs and Agents**，[arXiv:2607.08032](https://arxiv.org/abs/2607.08032)：用率失真（rate–distortion）框架回答"压缩该保什么、丢什么"——保留下游任务恢复所需的信息，把失真控制在可接受界内；为"摘要该写多详细"提供了理论标尺。
- **Active Context Compression: Autonomous Memory Management in LLM Agents**，[arXiv:2601.07190](https://arxiv.org/abs/2601.07190)：让代理**自主**管理上下文（何时压缩、压缩什么），而非依赖固定阈值。
- **Sculptor: Empowering LLMs with Cognitive Agency via Active Context Management**，[ICLR 2026](https://mlanthology.org/iclr/2026/li2026iclr-sculptor/)：把上下文管理设计为代理的"认知能力"，主动取舍。
- **PACMS: Submodular Context Selection as a Pluggable Engine for LLM Agents**，[arXiv:2606.20047](https://arxiv.org/abs/2606.20047)：用次模函数（submodular）做上下文子集选择——选择"信息增益最高"的消息子集，可插拔地接入代理循环。
- **ECHO: Prune to act, trace to learn with selective turn memory in agentic RL**，[arXiv:2606.31650](https://arxiv.org/abs/2606.31650)：在 agentic RL 里只保留"对行动有贡献"的轮次，减少噪声干扰。

**对本项目的启示**：这些工作共同指向一种**可插拔的"保留策略"层**——在每一步请求进入模型前，按策略选择哪些历史消息保留。DSH 的 `agent/pre-step` waterfall 正是该层的原生落点（详见 §5）。

### 3.3 推理侧压缩（KV cache，让每轮重读更便宜）

- **H2O（Heavy-Hitter Oracle）**，[arXiv:2306.14048](https://arxiv.org/abs/2306.14048)：只保留"重击 token"的 KV，降低显存与算力。
- **StreamingLLM**，[arXiv:2309.17453](https://arxiv.org/abs/2309.17453)：保留 attention sink + 最近窗口，支持无限流式生成。
- KV cache 压缩综述，[arXiv:2603.20397](https://huggingface.co/papers/2603.20397)。

**说明**：KV cache 压缩发生在推理引擎内部，对使用托管 API 的代理应用（如 DSH 默认形态）不可直接干预；本套件不涉及，仅在报告层面记录其存在与边界。

---

## 4. 工程开源方案调研（GitHub）

### 4.1 Claude Code hooks 生态（与本项目最接近的先行者）

- **[rtk](https://github.com/FlorianBruniaux/rtk)**（Rust）：透明代理 `git`/`find`/`grep`/`dev` 等命令，宣称把 Claude Code token 用量降低 60–90%；过滤发生在输出进入上下文之前。注意社区亦有讨论其 hook 会增加 18% 成本（[issue #582](https://github.com/rtk-ai/rtk/issues/582)），说明**过滤必须权衡自身开销**。
- **[squeez](https://github.com/claudioemmanuel/squeez)**：基于 hook 的压缩器，覆盖 5 个 AI CLI 宿主（Claude Code、Copilot CLI、OpenCode、Gemini CLI、Codex CLI），宣称 bash 输出最高 95% 压缩、代码读取签名模式、跨调用去重、零运行时依赖。
- **[pith](https://github.com/abhisekjha/pith)**：通过 hook 让 Claude Code 会话"延长 3 倍"——即同样的预算跑更多轮。
- **[ecotokens](https://docs.rs/crate/ecotokens/0.8.0)**（Rust crate）：命令行 token 计价/优化工具。
- 官方侧呼声：[Built-in tool output compression via PreToolUse hooks · anthropics/claude-code#44319](https://github.com/anthropics/claude-code/issues/44319)、[Use compact output flags for common Bash commands · anthropics/claude-code#32311](https://github.com/anthropics/claude-code/issues/32311)——证明"命令输出污染上下文"是社区公认痛点。

### 4.2 通用 prompt 压缩中间件

- **[leanctx](https://github.com/jia-gao/leanctx)**：LLMLingua-2 的工程化 drop-in，宣称账单降 40–60%，无需改业务代码。
- **[twotrim](https://github.com/overseek944/twotrim)**：超轻量、数学上稳健的 prompt 压缩中间件。
- **[Prompt-Compression-Benchmarker](https://github.com/dakshjain-1616/Prompt-Compression-Benchmarker)**：对 LLMLingua / Selective Context 等在真实负载上打分（质量、节省、延迟），并导出 OpenAI/Anthropic 的 drop-in wrapper——是"先测再上"思路的范本。

### 4.3 对本项目的启示

1. **过滤点必须在输出进入上下文之前**（post-execute 等价物），这是收益最高的位置；
2. **规则驱动、零运行时依赖**的形态（squeez）比 LLM 级压缩（leanctx）更适合代理内嵌——延迟与成本可控；
3. **必须有可观测性**：每次改写留下痕迹（marker 行 + 统计），否则难以排障（rtk 的成本争议即是教训）；
4. **压缩目标不是"越小越好"**，而是"保留下游真正需要的信息"（呼应 §3.2 率失真视角）。

---

## 5. DSH 框架现状与扩展点映射

### 5.1 DSH 原生已有的压缩骨架

| 能力 | DSH 包 | 说明 |
| --- | --- | --- |
| token 计量 | `@deepseek-ai/dsh-token-meter` | `tokenMeter.measure(session)` 返回 `{ totalTokens, surfaceTokens, nodes[] }`，replay 式重算，O(surface) |
| 压缩引擎 | `@deepseek-ai/dsh-compaction` | 抽象服务：`compactIfNeeded` / `compactNow` / `compactRegion`，配 `compaction/start|summary|end` 会话事件 |
| 基础压缩后端 | `@deepseek-ai/dsh-compaction-basic` | 压力触发（tokenMeter）与 context-overflow 触发；LLM 摘要器带结构化 checkpoint 指令 |
| 工具结果裁剪 | `@deepseek-ai/dsh-compaction-tool-result-pruner` | 确定性 head/middle/tail 截断（字符预算），对**文本**块操作，不识别语义 |
| 会话统计 | `@deepseek-ai/dsh-session-stats` | 轮次/步骤/耗时/输出 token 的投影 |
| 手动压缩 | `@deepseek-ai/dsh-command-compact` | `/compact` 人类命令 |

### 5.2 可挂接的 Cordis 扩展点（本套件使用的）

| 扩展点 | 类型 | 用途 |
| --- | --- | --- |
| `tools/post-execute` | waterfall | **接受/替换工具结果**——在结果进入上下文前改写（压缩）→ 落地"quiet flags / 输出限制" |
| `agent/pre-step` | waterfall | **替换进入步骤的消息**——选择性保留策略的落点 → 落地 Selective Context / 记忆压缩思路 |
| `session/event` | emit | 观察 `compaction/*` 事件，统计压缩收益 → 落地"可观测性/反馈回路" |
| `tokenMeter.measure` | service | 实时上下文占用与逐节点 token 分布 → 落地"健康度审计" |
| `tools.register` | service | 注册模型可见工具 `token_audit` → 落地"面向用户的审计/建议" |
| `system-prompt/assemble` | waterfall | 未来：裁剪启动提示（CLAUDE.md / skills 冗余） |
| `agent/request` | waterfall | 未来：按压力调整请求配置（max_tokens 等） |

### 5.3 Gap 分析：DSH 缺什么

1. **内容感知的噪声过滤**：`toolResultPruner` 只做字符预算截断，**不识别"400 行 PASS"这种低信息内容**——而博客与 rtk/squeez 都证明这是最大的浪费源；
2. **面向用户的上下文健康度审计**：`tokenMeter` 是给引擎用的，没有把"占用多少、谁最占、该做什么"翻译成人/模型可执行建议的出口；
3. **选择性上下文保留策略**：压缩只有"整段摘要"一种手段，缺少"按信息价值挑选保留哪几条历史消息"的细粒度策略层；
4. **压缩收益反馈回路**：压缩事件发生了，但没有"省了多少 token"的可视化/统计出口。

---

## 6. 插件套件设计（基于以上调研）

设计原则：**无损优先**（只删可重建或低价值内容）、**可观测**（每次改写留痕）、**可配置**（默认保守，激进项 opt-in）、**分层**（安全层常开，策略层可选）。

### 6.1 `noise-filter` —— 命令噪声过滤（对应 §2.2 #4、§4.1，落地 Gap #1）

在 `tools/post-execute` 中，对**已知噪声类别**的 bash 工具结果做**行级分类**压缩：

- 测试运行器（vitest/jest/pytest/go test 等）：丢弃逐条 PASS 行，保留 FAIL/ERROR 行 + 汇总；
- 构建工具（npm/pnpm/yarn/tsc/vite/cargo）：丢弃进度/旋转行，保留警告/错误/结果；
- `git log`/`git diff` 等：head/tail 保留 + 标记行；
- 兜底：超长输出 head/tail 保留 + 错误模式行保留 + 空行折叠。

安全约束：只改文本块；低于最小收益阈值不动；保留 exit code 语义；所有改写带 `[... N lines suppressed ...]` 标记。

### 6.2 `context-audit` —— 上下文健康度审计（对应 §2.2 #5，落地 Gap #2、#4）

注册模型工具 `token_audit`：读取 `tokenMeter.measure(session)`，输出上下文占用、分类型占用、Top 大块工具结果、压力百分比，并按规则给出**可执行建议**（压缩 / 清理 / 子代理 / 新会话），每条建议附带预估节省。同时监听 `compaction/*` 事件，统计最近压缩的 token 节省量，形成反馈回路。

### 6.3 `selective-context` —— 选择性上下文保留（对应 §3.2、§3.1，落地 Gap #3）

在 `agent/pre-step` 中实现**保守的选择性保留**：当投影压力超过阈值时，仅剔除满足全部条件的低价值工具结果（高 token、超过保留年龄、内容 95%+ 为噪声类行）。**默认关闭、显式 opt-in**，因为任何误删都会损害会话连续性——这与学术界"率失真/信息增益"取舍精神一致，但工程上把边界划得非常保守。

### 6.4 组合形态

三者可独立加载，也可作为套件整体加载：

```yaml
- id: noise-filter
  name: dsh-token-slim/noise-filter
- id: context-audit
  name: dsh-token-slim/context-audit
- id: selective-context
  name: dsh-token-slim/selective-context
  disabled: true   # 实验性，默认关闭
```

完整配置示例见 [compositions/cordis.example.yml](../compositions/cordis.example.yml)，实现细节见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 7. 验证方法

本套件在 DSH harness 中以**动态 Cordis 插件**形式做了实测验证（同一进程、同一接口），覆盖：

1. `tools/post-execute` 噪声压缩对真实命令输出（测试运行、git log 等）的压缩率与保真度（保留错误行）；
2. `token_audit` 工具基于真实 `tokenMeter` 测量的输出结构与建议触发；
3. 压缩收益跟踪对 `compaction/*` 事件的响应。

实测数据与截图记录于 [ARCHITECTURE.md](./ARCHITECTURE.md) 的验证章节。

---

## 8. 参考文献

**官方**
- Maximizing the value of your Claude Code sessions — https://claude.com/blog/maximizing-the-value-of-your-claude-code-sessions
- Lessons from building Claude Code: Prompt caching is everything — https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything

**论文**
- Selective Context — Compressing Context to Enhance Inference Efficiency of LLMs — https://arxiv.org/abs/2310.06201
- LLMLingua — https://arxiv.org/abs/2310.05736
- LongLLMLingua — https://arxiv.org/abs/2310.06839
- LLMLingua-2 — https://arxiv.org/abs/2403.12968
- Less is More: DocString Compression in Code Generation — https://arxiv.org/abs/2410.22793
- What to Keep, What to Forget: Rate–Distortion View of Memory Compaction — https://arxiv.org/abs/2607.08032
- Active Context Compression — https://arxiv.org/abs/2601.07190
- Sculptor: Active Context Management (ICLR 2026) — https://mlanthology.org/iclr/2026/li2026iclr-sculptor/
- PACMS: Submodular Context Selection — https://arxiv.org/abs/2606.20047
- ECHO: Selective turn memory in agentic RL — https://arxiv.org/abs/2606.31650
- H2O: Heavy-Hitter Oracle — https://arxiv.org/abs/2306.14048
- StreamingLLM — https://arxiv.org/abs/2309.17453
- KV Cache Optimization Strategies for Scalable and Efficient LLM Inference — https://huggingface.co/papers/2603.20397

**工程**
- rtk — https://github.com/FlorianBruniaux/rtk
- squeez — https://github.com/claudioemmanuel/squeez
- pith — https://github.com/abhisekjha/pith
- ecotokens — https://docs.rs/crate/ecotokens/0.8.0
- leanctx — https://github.com/jia-gao/leanctx
- twotrim — https://github.com/overseek944/twotrim
- Prompt-Compression-Benchmarker — https://github.com/dakshjain-1616/Prompt-Compression-Benchmarker
- anthropics/claude-code#44319 — https://github.com/anthropics/claude-code/issues/44319
- anthropics/claude-code#32311 — https://github.com/anthropics/claude-code/issues/32311
