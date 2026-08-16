/**
 * Command-aware, content-aware tool-result compression.
 *
 * Implements the "quiet flags / output limits" technique from the research
 * report as a post-execute rewrite: outputs of known noisy command classes
 * (test runners, build tools, git, listing) are filtered line by line —
 * low-value lines are dropped, high-value lines (failures, warnings,
 * summaries) are always kept, and ambiguous lines are kept head/tail.
 *
 * The rewrite is conservative by design:
 *  - only text blocks are touched;
 *  - a result below the minimum size or savings threshold is left unchanged;
 *  - every rewrite appends a marker line, so the change is observable.
 *
 * @module dsh-token-slim/noise-filter/filter
 */

import {
  classifyLine,
  collapseBlankLines,
  DEFAULT_KEEP_PATTERNS,
  DEFAULT_NOISE_PATTERNS,
  stripAnsi,
} from '../lib/lines.js'

/**
 * Command classes and the pattern used to detect them from a bash command.
 * Detection is intentionally prefix/word based so `npm test -- --watch`
 * still matches `npm test`.
 */
export const COMMAND_CLASSES = [
  {
    id: 'test',
    re: /(^|[^a-z])(vitest|jest|mocha|jasmine|rspec|pytest|go\s+test|cargo\s+test|npm\s+(test|run\s+test)|pnpm\s+(test|run\s+test)|yarn\s+(test|run\s+test)|gradle\s+test|mvn\s+test)\b/i,
  },
  {
    id: 'build',
    re: /\b(npm|pnpm|yarn)\s+(install|ci|add|build)\b|\btsc\b|\bvite\s+build\b|\bwebpack\b|\besbuild\b|\bcargo\s+build\b|\bmake\b|\bgradle\s+(build|assemble)\b|\bmvn\s+(install|package)\b/i,
  },
  {
    id: 'git',
    re: /\bgit\s+(log|diff|status|show)\b/i,
  },
  {
    id: 'list',
    re: /\b(find|tree)\b/i,
  },
]

/** Per-class thresholds; user config overrides these. */
export const CLASS_POLICY = {
  test: { minChars: 800, headLines: 8, tailLines: 8 },
  build: { minChars: 2000, headLines: 6, tailLines: 6 },
  git: { minChars: 1500, headLines: 10, tailLines: 5 },
  list: { minChars: 2000, headLines: 15, tailLines: 10 },
}

export const DEFAULT_MARKER =
  '[dsh-token-slim] suppressed {suppressed} of {total} lines ({before} -> {after} chars); errors preserved'

/**
 * Detect the command class of a bash command string.
 * @param {string} command
 * @returns {string | null} one of the class ids, or null when unknown.
 */
export function classifyCommand(command) {
  for (const cls of COMMAND_CLASSES) {
    if (cls.re.test(command)) return cls.id
  }
  return null
}

/**
 * Compress one text payload under a policy.
 * @param {string} text raw tool-result text (may contain ANSI codes).
 * @param {{
 *   keep?: RegExp[]; noise?: RegExp[];
 *   headLines?: number; tailLines?: number;
 *   minChars?: number; minSavingsChars?: number; marker?: string;
 * }} policy
 * @returns {{ text: string; stats: object } | null} null when no rewrite is
 *   worthwhile (below thresholds or nothing suppressible).
 */
export function compressText(text, policy = {}) {
  const keep = policy.keep ?? DEFAULT_KEEP_PATTERNS
  const noise = policy.noise ?? DEFAULT_NOISE_PATTERNS
  const headLines = policy.headLines ?? 10
  const tailLines = policy.tailLines ?? 10
  const minChars = policy.minChars ?? 2000
  const minSavingsChars = policy.minSavingsChars ?? 500
  const marker = policy.marker ?? DEFAULT_MARKER

  const clean = stripAnsi(text)
  const lines = clean.split('\n')
  const beforeChars = clean.length

  const kept = []
  const ambiguous = []
  let noiseCount = 0

  for (const line of lines) {
    const kind = classifyLine(line, { keep, noise })
    if (kind === 'noise') noiseCount += 1
    else if (kind === 'ambiguous') ambiguous.push(line)
    else kept.push(line)
  }

  // Ambiguous lines keep their head and tail; the middle is suppressible too,
  // so long unclassified outputs (e.g. `git log`) still get head/tail framing.
  const ambiguousKept =
    ambiguous.length <= headLines + tailLines
      ? ambiguous
      : [...ambiguous.slice(0, headLines), ...ambiguous.slice(-tailLines)]
  const suppressedAmbiguous = ambiguous.length - ambiguousKept.length

  const suppressed = noiseCount + suppressedAmbiguous
  if (suppressed === 0) return null

  const body = collapseBlankLines([...kept, ...ambiguousKept])
  const afterChars = body.join('\n').length
  const savingsChars = beforeChars - afterChars

  if (savingsChars < minSavingsChars) return null

  const markerLine = marker
    .replace('{suppressed}', String(suppressed))
    .replace('{total}', String(lines.length))
    .replace('{before}', String(beforeChars))
    .replace('{after}', String(afterChars))

  const stats = {
    beforeChars,
    afterChars,
    savingsChars,
    totalLines: lines.length,
    suppressedLines: suppressed,
    keptLines: kept.length + ambiguousKept.length,
  }

  return { text: `${body.join('\n')}\n${markerLine}`, stats }
}

/**
 * Compress a bash tool result for a known command class.
 * @param {string} command the executed bash command.
 * @param {string} text tool-result text.
 * @param {{
 *   minChars?: number; minSavingsChars?: number;
 *   headLines?: number; tailLines?: number; marker?: string;
 *   enableClasses?: string[]; keep?: RegExp[]; noise?: RegExp[];
 * }} config resolved plugin config.
 * @returns {{ text: string; stats: object } | null}
 */
export function compressBashResult(command, text, config = {}) {
  const cls = classifyCommand(command)
  const enabled = config.enableClasses ?? ['test', 'build', 'git', 'list']
  if (cls === null || !enabled.includes(cls)) return null
  const policy = { ...CLASS_POLICY[cls] }
  for (const key of ['minChars', 'minSavingsChars', 'headLines', 'tailLines', 'marker']) {
    if (config[key] !== undefined) policy[key] = config[key]
  }
  if (config.keep !== undefined) policy.keep = config.keep
  if (config.noise !== undefined) policy.noise = config.noise
  return compressText(text, policy)
}
