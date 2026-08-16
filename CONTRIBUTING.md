# Contribution guidelines

Thanks for considering a contribution to `dsh-token-slim`.

## Scope

This repository ships three small Cordis plugins for DeepSeek Harness. Keep
contributions aligned with the design principles in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):

- **lossless-first** — only remove content that is low-value or reconstructible;
- **observable** — every rewrite leaves a marker and reports statistics;
- **conservative defaults** — experimental behavior is opt-in;
- **never break the pipeline** — a failing filter must fall back to the
  downstream decision, never throw into the agent loop.

## Development

```bash
npm install --omit=peer   # cordis/schemastery peers live inside a DSH deployment
npm test                  # node --test on the pure modules
```

## Adding a rule or a pattern

Classification lives in `src/lib/lines.js` (defaults) and
`src/noise-filter/filter.js` (command classes). Add a test in the matching
`*.test.js` file for every new pattern — including a *negative* case proving
high-value lines are never dropped.

## Commit and PR

- One logical change per commit, conventional style prefix optional but nice.
- Update `docs/RESEARCH.md` or `docs/ARCHITECTURE.md` when behavior or
  rationale changes.
- Run `npm test` before pushing; CI runs it on Node 20 and 22.

## License

By contributing you agree that your contribution is licensed under the MIT
license of this repository.
