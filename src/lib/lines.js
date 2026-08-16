/**
 * Shared line-level classification for token-slim.
 *
 * Both `noise-filter` and `selective-context` decide what may be dropped from a
 * tool result by classifying each line as high-value (`keep`), low-value
 * (`noise`) or undecidable (`ambiguous`). The rules are deliberately
 * conservative: when in doubt, a line is kept.
 *
 * @module dsh-token-slim/lib/lines
 */

export const KEEP = 'keep'
export const NOISE = 'noise'
export const AMBIGUOUS = 'ambiguous'

/** High-value patterns: failure, warnings, decisions, stack frames, summaries. */
export const DEFAULT_KEEP_PATTERNS = [
  /\bFAIL(?:ED|URE)?\b/i,
  /\bERROR\b/i,
  /\bWARN(?:ING)?\b/i,
  /\bException\b/i,
  /\bpanic:\b/i,
  /\bAssertionError\b/i,
  /\b✗\b/,
  /\bexpected\b/i,
  /\breceived\b/i,
  /:\d+:\d+\b/, // stack frames: file:line:col
  /^\s*--- FAIL:/,
  /^\s*(Test Suites|Test Files|Tests):/,
  /^\s*\d+ (passed|failed|skipped|todo)/,
  /^\s*ok\s+\S+\s+[\d.]+s\s*$/, // go test package summary: "ok pkg 0.5s"
  /^\s*FAIL\s+\S+/i, // go test failure summary: "FAIL pkg"
  /^npm error\b/i,
  /^\s*Caused by:/,
  /^\s*at\s+\S+\s*\(/, // JS stack frame
]

/** Low-value patterns: per-case passes, progress, spinners, separators. */
export const DEFAULT_NOISE_PATTERNS = [
  /^\s*✓\s/,
  /^\s*✔\s/,
  /^\s*PASS(?:ED)?\s/i,
  /^\s*--- PASS:/,
  /^\s*=== RUN\s/,
  /^\s*test\s+.+\.\.\.\s+ok\s*$/i, // cargo per-case pass
  /^\s*[.\-]+$/, // dot matrices / separators
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u, // spinner frames
  /^\s*[▹▸]+$/, // progress bar fill
  /^\s*[━─]+$/, // horizontal rules
]

/**
 * Remove ANSI escape sequences from a tool-result text.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '').replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
}

/**
 * Classify a single line against keep/noise patterns. Keep patterns win; a line
 * matching neither is ambiguous.
 * @param {string} line
 * @param {{ keep: RegExp[]; noise: RegExp[] }} patterns
 * @returns {'keep'|'noise'|'ambiguous'}
 */
export function classifyLine(line, patterns) {
  for (const re of patterns.keep) {
    if (re.test(line)) return KEEP
  }
  for (const re of patterns.noise) {
    if (re.test(line)) return NOISE
  }
  return AMBIGUOUS
}

/**
 * Collapse runs of blank lines into a single blank line.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function collapseBlankLines(lines) {
  const out = []
  let prevBlank = false
  for (const line of lines) {
    const blank = line.trim() === ''
    if (blank && prevBlank) continue
    out.push(line)
    prevBlank = blank
  }
  return out
}
