# Token 优化插件套件 —— 架构与验证文档

本文档说明 `dsh-token-slim` 套件在 DSH 上的设计理由、扩展点选择、配置词汇表与实测验证结果。

## 1. 设计原则

| 原则 | 含义 | 落地方式 |
| --- | --- | --- |
| 无损优先 | 只删"可重建或低价值"内容 | noise-filter 只删噪声行；selective-context 只要有一行高价值内容就整条保留 |
| 可观测 | 每次改写都留痕 | 重写附加 `[dsh-token-slim] ...` 标记行；audit 工具报告压缩累计收益 |
| 可配置 | 默认保守、激进项 opt-in | selective-context 默认 `enabled: false` |
| 不破坏管道 | 优化失败不能伤害会话 | 所有 waterfall 监听器在异常时回退 `next()` 的结果 |
| 组合优于重写 | 复用 DSH 原生引擎 | 不碰 `compaction`/`tokenMeter`/`toolResultPruner`，只在外围挂接 |

## 2. 扩展点选择（与调研报告的映射）

| DSH 扩展点 | 类型 | 插件 | 对应的调研技术 |
| --- | --- | --- | --- |
| `tools/post-execute` | waterfall | noise-filter | Claude 博客 #4（quiet flags/输出限制）；rtk/squeez 的输出过滤；BASH_MAX_OUTPUT_LENGTH 语义 |
| `tokenMeter.measure` | service | context-audit | 博客 #5（/context 习惯）；token 成本意识（缓存/输入输出定价） |
| `session/event` + `compaction/summary` | emit | context-audit | 博客 #6（/compact 时机）；"压缩省了多少"反馈回路 |
| `tools.register` | service | context-audit | 把健康度审计变成模型可见工具 |
| `agent/pre-step` | waterfall | selective-context | Selective Context（arXiv:2310.06201）；Rate-Distortion 记忆压缩（arXiv:2607.08032）；PACMS（arXiv:2606.20047） |
| `agent/turn-stopping` | serial | context-audit | 轮次计数（审计建议的依据之一） |

**刻意不做的**：KV cache 压缩（H2O/StreamingLLM）位于推理引擎内部，对托管 API 应用不可干预；LLM 级 prompt 压缩（LLMLingua）延迟与成本不可控，工程形态应降维为规则驱动（squeez 路线）。

## 3. 配置词汇表

### noise-filter（`dsh-token-slim/noise-filter`）

| key | 默认 | 说明 |
| --- | --- | --- |
| `applyToTools` | `['bash']` | 允许重写的工具名 |
| `enableClasses` | `['test','build','git','list']` | 启用的命令类别 |
| `minChars` | `2000` | 低于此长度不进入重写判定 |
| `minSavingsChars` | `500` | 节省低于此值则放弃重写 |
| `headLines` / `tailLines` | `10` / `10` | 模糊行头尾保留数量 |
| `keepPatterns` / `noisePatterns` | `[]` | 追加的保留/噪声正则（字符串） |
| `marker` | 见源码 | 重写标记模板，支持 `{suppressed}/{total}/{before}/{after}` |

### context-audit（`dsh-token-slim/context-audit`）

| key | 默认 | 说明 |
| --- | --- | --- |
| `contextLimitTokens` | `200000` | 压力百分比的分母 |
| `topOffenders` | `8` | 报告列出多少个最大占用节点 |
| `toolName` | `token_audit` | 注册的工具名 |
| `trackCompaction` | `true` | 是否跟踪 `compaction/summary` 收益 |
| `maxCompactionHistory` | `10` | 内存中保留的压缩历史条数 |

### selective-context（`dsh-token-slim/selective-context`）

| key | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关，实验性 |
| `pressureThresholdTokens` | `150000` | 超过才考虑过滤 |
| `minTokens` | `2000` | 单条消息最小可删 token |
| `minAgeTurns` | `3` | 最少历史轮数 |
| `noiseRatioThreshold` | `0.95` | 噪声行占比阈值 |
| `maxDropPerStep` | `2` | 每步最多删除条数 |

## 4. 组合形态

```yaml
# agent preset 或 host 组合中的三行（均不发布服务）
- id: noise-filter
  name: dsh-token-slim/noise-filter
  config: { minChars: 2000, minSavingsChars: 500 }

- id: context-audit
  name: dsh-token-slim/context-audit
  config: { contextLimitTokens: 200000 }

- id: selective-context
  name: dsh-token-slim/selective-context
  disabled: true
  config: { enabled: false }
```

## 5. 验证

### 5.1 单元测试（零运行时依赖）

```bash
npm test
# 17 tests, 17 pass
```

覆盖：命令类别识别、噪声行压缩与阈值、失败/汇总行保真、git head/tail、
audit 报告与建议触发、selective retention 的保守边界（含高价值行不删、
读不懂不删、太年轻不删）。

### 5.2 DSH 运行时实测

> 以下数据来自开发过程中，将套件核心逻辑以**动态 Cordis 插件**形态在 DSH harness 同进程、同接口下实测（`tksl-1/pkg-4`，运行于本会话）。

**① tools/post-execute 噪声压缩（noise-filter 核心）**

构造模拟测试运行器输出（`npm test` 类，87 行，2892 字符）：

```text
  PASS  src/foo1.test.ts (1 ms)
  ... 共 80 行 PASS ...
  FAIL  src/bar.test.ts
    AssertionError: expected 1 to equal 2
    at src/bar.test.ts:14:5
 Test Files  1 failed | 80 passed (81)
 Tests       1 failed | 79 passed (80)
```

插件改写后模型实际收到：

```text
  FAIL  src/bar.test.ts
    AssertionError: expected 1 to equal 2
    at src/bar.test.ts:14:5
 Test Files  1 failed | 80 passed (81)
 Tests       1 failed | 79 passed (80)
running: npm test

[dsh-token-slim] suppressed 80 of 87 lines (2892 -> 190 chars); errors preserved
```

- 80/87 行被抑制（PASS 行全部删除）；**错误、断言、堆栈、汇总全部保留**；
- 字符数 2892 → 190，**减少 93.4%**；每轮重读的节省随轮次线性放大。

**② git 类 head/tail 兜底**

`git log --oneline -60 --format="%h %s (%an, %ar)"`（61 行，5243 字符）→ 保留头尾 20 行 + 标记行（1947 字符），**减少 62.9%**。

**③ 关键发现：PostToolDecision 的 content 语义**

实测发现默认 `next()` 返回 `{ kind: 'accept' }`（**不含 content**），注册表仅在 `decision.content !== undefined` 时才替换内容。因此过滤器的判定条件必须是 `decision.kind === 'accept' && decision.value === undefined`（而不是检查 `content`），否则内容感知重写永远不会生效。此修正已同步到仓库代码（`src/noise-filter/plugin.js`）。

**④ 工具注册与 schema 约束**

`harness.defineTool` 对参数/输出 schema 有严格校验：无参工具的 `parameters` 不可携带 `additionalProperties: false`；输出 schema 必须显式声明 `additionalProperties`。修正后 `token_audit` 正常进入模型工具集（`Tool.listTools` 可见）。`context-audit` 的执行路径（`tokenMeter.measure(agent.session)` + 报告构建）由单元测试覆盖纯函数部分。

## 6. 已知边界与后续工作

- `noise-filter` 目前只处理 `bash` 工具；`git` 类命令重写保持 head/tail，不做行级语义（未来可做 `--stat` 专精）。
- `context-audit` 的节省估算均为启发式（压缩 ≈ 表面 60%），用于决策参考而非计费。
- `selective-context` 仅按"轮龄 + 噪声占比"判定，未做检索式记忆；未来可接入子代理代答（ECHO 路线）。
- 压缩收益目前存内存；如需跨进程持久化，可接入 `storageDomain`。
- 插件入口依赖 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`（DSH 部署自带，声明为 peer 依赖）。
