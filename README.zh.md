# dsh-token-slim

面向 **DeepSeek Harness (DSH)** 的 Token 优化插件套件。三个可组合的 Cordis 插件，把 [docs/RESEARCH.md](docs/RESEARCH.md)（调研报告）中的技术落地到 DSH 原生扩展点上，不改动 DSH 自带的压缩引擎。

```
+-----------------------+      +------------------------+      +--------------------------+
| noise-filter          |      | context-audit          |      | selective-context        |
| tools/post-execute    |      | tokenMeter + tools     |      | agent/pre-step           |
| 压缩噪声命令输出      |      | 健康度审计与建议       |      | 保守的选择性保留         |
| （逐行分类）          |      | + 压缩收益反馈         |      | （实验性，默认关闭）     |
+-----------------------+      +------------------------+      +--------------------------+
```

| 插件 | DSH 扩展点 | 调研依据 | 默认 |
| --- | --- | --- | --- |
| `dsh-token-slim/noise-filter` | `tools/post-execute` | Claude 博客 "quiet flags / 输出限制"、rtk / squeez | **开启** |
| `dsh-token-slim/context-audit` | `tokenMeter.measure` + `tools.register` + `session/event` | `/context` 习惯、token 成本意识 | **开启** |
| `dsh-token-slim/selective-context` | `agent/pre-step` | Selective Context / 记忆压缩论文 | **关闭**（实验性） |

## 为什么做这个

在 agentic 编码工具中，每一个进入上下文的 token 都会在之后每一轮被反复重读。因此最高杠杆的优化是：(1) 让噪声命令输出**不进**上下文；(2) 知道自己烧了多少上下文、该怎么办；(3) 压力大时只保留高价值历史。DSH 已自带压缩**引擎**（`tokenMeter`、`compaction`、`toolResultPruner`），本套件在其外围补齐"内容感知过滤"与"用户可见的审计层"。完整调研见 [docs/RESEARCH.md](docs/RESEARCH.md)。

## 安装

插件运行在 **DSH 部署内部**，其 `node_modules` 已提供 peer 依赖 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`。

```bash
npm install dsh-token-slim   # 安装进部署的 node_modules
```

然后在部署的 `cordis.yml`（host 或 agent preset）中增加行：

```yaml
- id: noise-filter
  name: dsh-token-slim/noise-filter

- id: context-audit
  name: dsh-token-slim/context-audit

- id: selective-context
  name: dsh-token-slim/selective-context
  disabled: true   # 实验性——先读文档再启用
  config:
    enabled: false
```

三个插件都不发布服务，因此可以平铺放在 preset（或 host）组合中；见 [compositions/cordis.example.yml](compositions/cordis.example.yml)。

> **关于 realm**：如果这些行被放进带 `isolate` realm 的 group，必须与它们消费的 host 服务（`tools`、`tokenMeter`）同组。在普通无 realm 的 preset 中无需处理。

## 插件说明

### noise-filter

对成功的 `bash` 工具结果做重写，仅当命令匹配已知噪声类别（测试运行器、构建工具、`git`、列目录）。逐行处理：

- **保留** —— 失败、错误、警告、堆栈帧、汇总行；
- **丢弃** —— 逐用例 PASS、进度条、旋转符、分隔线；
- **模糊行** —— 保留头尾，压缩中间。

每次重写都会附加标记行，且不改变 exit code。低于 `minChars` / `minSavingsChars` 的结果绝不改动。

```yaml
- id: noise-filter
  name: dsh-token-slim/noise-filter
  config:
    minChars: 2000
    minSavingsChars: 500
    headLines: 10
    tailLines: 10
    enableClasses: [test, build, git, list]
    keepPatterns: []
    noisePatterns: []
    marker: '[dsh-token-slim] suppressed {suppressed} of {total} lines ({before} -> {after} chars); errors preserved'
```

### context-audit

注册模型可见工具 `token_audit`，基于 `tokenMeter.measure(session)` 输出：

- 总 token / 表面 token 与相对配置上限的压力百分比；
- 最大的工具结果占用者（seq、token、占表面比例）；
- 从 `compaction/summary` 事件累计的压缩收益；
- 可执行建议（`compact` / `prune` / `clear` / `subagent` / `continue`），每条带诚实的启发式节省估算。

```yaml
- id: context-audit
  name: dsh-token-slim/context-audit
  config:
    contextLimitTokens: 200000
    topOffenders: 8
    toolName: token_audit
    trackCompaction: true
```

### selective-context（实验性，默认关闭）

挂接 `agent/pre-step`，仅当投影表面 token 超过 `pressureThresholdTokens` 时，剔除**同时满足**以下条件的工具结果消息：早于 `minAgeTurns` 轮、至少 `minTokens` token、且 ≥ `noiseRatioThreshold` 比例为噪声行（只要含一行高价值内容就整体保留）。每步最多丢弃 `maxDropPerStep` 条。请在自己工作负载上验证后再启用。

```yaml
- id: selective-context
  name: dsh-token-slim/selective-context
  config:
    enabled: true
    pressureThresholdTokens: 150000
    minTokens: 2000
    minAgeTurns: 3
    noiseRatioThreshold: 0.95
    maxDropPerStep: 2
```

## 开发

```bash
npm install --omit=peer
npm test                       # 纯模块 node --test
```

纯决策核心（`src/noise-filter/filter.js`、`src/context-audit/audit.js`、`src/selective-context/retention.js`）零运行时依赖、完整单元测试；Cordis 入口文件（`src/*/plugin.js`）需要 DSH 部署才能运行。

## 文档

- [docs/RESEARCH.md](docs/RESEARCH.md) — 调研报告：Claude Code 官方技巧、arXiv 论文、GitHub 开源方案
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 设计理由、扩展点映射、验证结果
- [compositions/cordis.example.yml](compositions/cordis.example.yml) — 可直接改用的组合配置

## License

MIT — 见 [LICENSE](LICENSE)。
