/**
 * Conservative selective-retention decision for `agent/pre-step`.
 *
 * Implements the "selective context" idea from the research report at the
 * coarsest safe granularity: when the projected surface is over budget, only
 * *tool-result* messages that are all of
 *   - older than `minAgeTurns` turns,
 *   - individually at least `minTokens` tokens,
 *   - whose text is ≥ `noiseRatioThreshold` low-value (noise-class) lines,
 * are candidates for removal. Any doubt keeps the message.
 *
 * The decision function is pure and unit-tested; the plugin is disabled by
 * default because dropping history always risks losing context.
 *
 * @module dsh-token-slim/selective-context/retention
 */

import { classifyLine, DEFAULT_KEEP_PATTERNS, DEFAULT_NOISE_PATTERNS, stripAnsi } from '../lib/lines.js'

/**
 * @param {{
 *   seq: number; tokens: number; turn: number;
 *   text?: string;
 * }} message - one surface node candidate (subset of real fields).
 * @param {{
 *   minTokens?: number; minAgeTurns?: number;
 *   noiseRatioThreshold?: number; keep?: RegExp[]; noise?: RegExp[];
 * }} options
 * @returns {boolean} true when the message may be dropped.
 */
export function isDropCandidate(message, options = {}) {
  if (message === null || typeof message !== 'object') return false
  const minTokens = options.minTokens ?? 2000
  const minAgeTurns = options.minAgeTurns ?? 3
  const noiseRatioThreshold = options.noiseRatioThreshold ?? 0.95

  if (message.tokens < minTokens) return false
  // Age: prefer an explicit ageTurns; otherwise derive from currentTurn - turn.
  const age =
    options.currentTurn !== undefined && typeof message.turn === 'number'
      ? Math.max(0, options.currentTurn - message.turn)
      : (message.ageTurns ?? 0)
  if (age < minAgeTurns) return false
  if (typeof message.text !== 'string' || message.text.length === 0) return false

  const keep = options.keep ?? DEFAULT_KEEP_PATTERNS
  const noise = options.noise ?? DEFAULT_NOISE_PATTERNS
  const lines = stripAnsi(message.text).split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return false

  let noiseLines = 0
  let keepLines = 0
  for (const line of lines) {
    const kind = classifyLine(line, { keep, noise })
    if (kind === 'noise') noiseLines += 1
    else if (kind === 'keep') keepLines += 1
  }
  // A single high-value line makes the whole result undroppable.
  if (keepLines > 0) return false
  return noiseLines / lines.length >= noiseRatioThreshold
}

/**
 * Select which candidate messages to drop from the step input.
 * @param {Array<object>} messages
 * @param {object} options
 * @returns {{ drop: object[]; keep: object[] }}
 */
export function selectRetention(messages, options = {}) {
  const drop = []
  const keep = []
  for (const message of messages) {
    if (isDropCandidate(message, options)) drop.push(message)
    else keep.push(message)
  }
  return { drop, keep }
}
