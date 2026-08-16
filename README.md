# dsh-token-slim

Token optimization plugin suite for **DeepSeek Harness (DSH)**. Three composable Cordis plugins that apply the techniques researched in [docs/RESEARCH.md](docs/RESEARCH.md) to the extension points DSH already provides — without touching the shipped compaction engine.

```
+-----------------------+      +------------------------+      +--------------------------+
| noise-filter          |      | context-audit          |      | selective-context        |
| tools/post-execute    |      | tokenMeter + tools     |      | agent/pre-step           |
| compress noisy bash   |      | health report + advice |      | conservative retention   |
| outputs line-by-line  |      | + compaction savings   |      | (experimental, opt-in)   |
+-----------------------+      +------------------------+      +--------------------------+
```

| Plugin | DSH extension point | Research basis | Default |
| --- | --- | --- | --- |
| `dsh-token-slim/noise-filter` | `tools/post-execute` | "quiet flags / output limits" (Claude blog), rtk / squeez | **on** |
| `dsh-token-slim/context-audit` | `tokenMeter.measure` + `tools.register` + `session/event` | `/context` habit, token-cost awareness | **on** |
| `dsh-token-slim/selective-context` | `agent/pre-step` | Selective Context / memory-compaction papers | **off** (experimental) |

## Why

In agentic coding tools every token that enters the context is re-read on every
later turn. The highest-leverage optimizations are therefore: (1) keep noisy
command output *out* of the context, (2) know how much context you are burning
and what to do about it, (3) when under pressure, keep only the high-value
history. DSH already ships the compression *engine* (`tokenMeter`, `compaction`,
`toolResultPruner`); this suite adds the content-aware and user-facing layers
around it. See [docs/RESEARCH.md](docs/RESEARCH.md) for the full report.

## Install

The plugins run **inside a DSH deployment**, which already provides
`@deepseek-ai/cordis` and `@deepseek-ai/schemastery` as peers.

```bash
npm install dsh-token-slim        # into the deployment's node_modules
```

Then add rows to the deployment's `cordis.yml` (host or an agent preset):

```yaml
- id: noise-filter
  name: dsh-token-slim/noise-filter

- id: context-audit
  name: dsh-token-slim/context-audit

- id: selective-context
  name: dsh-token-slim/selective-context
  disabled: true   # experimental — read the docs before enabling
  config:
    enabled: false
```

All three plugins publish no services, so they sit loose in a preset (or host)
composition; see [compositions/cordis.example.yml](compositions/cordis.example.yml).

> **Note on realms**: if you mount these rows inside a group with an `isolate`
> realm, they must stay in the same group as the host services they consume
> (`tools`, `tokenMeter`). In a plain preset without realms there is nothing to
> do.

## Plugins

### noise-filter

Rewrites successful `bash` tool results whose command matches a known noisy
class (test runners, build tools, `git`, listing). Line-by-line:

- **keep** — failures, errors, warnings, stack frames, summary lines;
- **drop** — per-case passes, progress bars, spinners, separators;
- **ambiguous** — head/tail retained, middle suppressed.

Every rewrite appends a marker line and leaves the exit code untouched. A
result below `minChars` / `minSavingsChars` is never touched.

```yaml
- id: noise-filter
  name: dsh-token-slim/noise-filter
  config:
    minChars: 2000            # only consider results above this size
    minSavingsChars: 500      # only rewrite when at least this much is saved
    headLines: 10             # ambiguous head/tail retention
    tailLines: 10
    enableClasses: [test, build, git, list]
    keepPatterns: []          # extra regex sources, appended to defaults
    noisePatterns: []
    marker: '[dsh-token-slim] suppressed {suppressed} of {total} lines ({before} -> {after} chars); errors preserved'
```

### context-audit

Registers a model-visible tool `token_audit`. Reading `tokenMeter.measure(session)` it reports:

- total / surface token counts and pressure percent against a configured limit;
- the largest tool-result offenders (seq, tokens, % of surface);
- cumulative compaction savings tracked from `compaction/summary` events;
- actionable suggestions (`compact`, `prune`, `clear`, `subagent`, `continue`)
  each with an honest heuristic savings estimate.

```yaml
- id: context-audit
  name: dsh-token-slim/context-audit
  config:
    contextLimitTokens: 200000
    topOffenders: 8
    toolName: token_audit
    trackCompaction: true
```

### selective-context (experimental, off by default)

Hooks `agent/pre-step` and, only when the projected surface is above
`pressureThresholdTokens`, drops *tool-result* messages that are all of: older
than `minAgeTurns`, at least `minTokens` tokens, and ≥ `noiseRatioThreshold`
noise-classified lines (any single high-value line keeps the whole message).
At most `maxDropPerStep` messages are dropped per step. Enable only after
validating on your own workloads.

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

## Development

```bash
npm install --omit=peer
npm test                       # node --test on the pure modules
```

The pure decision cores (`src/noise-filter/filter.js`,
`src/context-audit/audit.js`, `src/selective-context/retention.js`) are fully
unit-tested and have no runtime dependencies; the Cordis entry files
(`src/*/plugin.js`) only need a DSH deployment to run.

## Documentation

- [docs/RESEARCH.md](docs/RESEARCH.md) — 调研报告：Claude Code 官方技巧、arXiv 论文、GitHub 开源方案（中文）
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design rationale, extension-point mapping, validation results
- [compositions/cordis.example.yml](compositions/cordis.example.yml) — ready-to-adapt composition rows

## License

MIT — see [LICENSE](LICENSE).
