/**
 * Pure context-audit report builder.
 *
 * Turns a `TokenMeasurement` (from `ctx.tokenMeter.measure(session)`) and the
 * plugin's compaction history into a detached, JSON-safe report plus a list of
 * actionable suggestions. Every suggestion maps to a technique from the
 * research report (compact / clear / prune / subagent / fresh session) and
 * carries an honest, heuristic savings estimate.
 *
 * @module dsh-token-slim/context-audit/audit
 */

/**
 * @param {{
 *   totalTokens: number; surfaceTokens: number;
 *   nodes: readonly { seq: number; tokens: number }[];
 * }} measurement - tokenMeter.measure() result (fields only).
 * @param {{
 *   contextLimitTokens?: number; topOffenders?: number;
 *   compactionHistory?: readonly { savedTokens: number; at: number }[];
 *   turns?: number;
 * }} options
 * @returns {object} JSON-safe audit report.
 */
export function buildAuditReport(measurement, options = {}) {
  const limit = options.contextLimitTokens ?? 200_000
  const topCount = options.topOffenders ?? 8
  const turns = options.turns ?? 0
  const compactionHistory = options.compactionHistory ?? []

  const { totalTokens, surfaceTokens, nodes } = measurement
  const pressurePercent =
    limit > 0 ? Math.round((totalTokens / limit) * 100) : null

  const sorted = [...nodes].sort((a, b) => b.tokens - a.tokens)
  const topOffenders = sorted.slice(0, topCount).map((node) => ({
    seq: node.seq,
    tokens: node.tokens,
    percentOfSurface:
      surfaceTokens > 0 ? Math.round((node.tokens / surfaceTokens) * 1000) / 10 : 0,
  }))

  const totalCompactionSaved = compactionHistory.reduce(
    (sum, entry) => sum + entry.savedTokens,
    0,
  )

  const report = {
    totalTokens,
    surfaceTokens,
    pressurePercent,
    contextLimitTokens: limit,
    turns,
    topOffenders,
    compaction: {
      count: compactionHistory.length,
      totalSavedTokens: totalCompactionSaved,
    },
    suggestions: buildSuggestions({
      pressurePercent,
      surfaceTokens,
      totalTokens,
      topOffenders,
      turns,
      compactionCount: compactionHistory.length,
      totalCompactionSaved,
    }),
  }
  return report
}

/**
 * @param {{
 *   pressurePercent: number | null; surfaceTokens: number; totalTokens: number;
 *   topOffenders: { tokens: number; percentOfSurface: number }[];
 *   turns: number; compactionCount: number; totalCompactionSaved: number;
 * }} input
 * @returns {Array<{ kind: string; reason: string; estimatedSavingsTokens?: number }>}
 */
export function buildSuggestions(input) {
  const suggestions = []
  const {
    pressurePercent,
    surfaceTokens,
    totalTokens,
    topOffenders,
    turns,
    compactionCount,
    totalCompactionSaved,
  } = input

  // Pressure is the primary signal: compaction rewrites the oldest span into a
  // summary, so the heuristic assumes ~60% of the current surface is reclaimable.
  if (pressurePercent !== null && pressurePercent >= 80) {
    suggestions.push({
      kind: 'compact',
      reason: `Context pressure is ${pressurePercent}% of the configured limit; compact the older span to reclaim working space.`,
      estimatedSavingsTokens: Math.round(surfaceTokens * 0.6),
    })
  }

  // A single oversized tool result is the classic "400 lines of PASS" problem.
  const biggest = topOffenders[0]
  if (biggest !== undefined && biggest.tokens >= 1000) {
    suggestions.push({
      kind: 'prune',
      reason: `The largest tool result is ~${biggest.tokens} tokens (${biggest.percentOfSurface}% of surface). Re-run the command with quiet flags or tail so only the meaningful lines enter the context.`,
      estimatedSavingsTokens: Math.max(0, Math.round(biggest.tokens * 0.7)),
    })
  }

  // A long session re-reads everything on every turn.
  if (turns >= 40 && (pressurePercent === null || pressurePercent >= 50)) {
    suggestions.push({
      kind: 'clear',
      reason: `This session has ${turns} turns; every turn re-reads the whole history. Start a fresh session for the next independent task.`,
      estimatedSavingsTokens: Math.round(totalTokens * 0.5),
    })
  }

  // Noisy, high-volume work belongs in a subagent context.
  const heavy = topOffenders.filter((node) => node.tokens >= 500)
  if (heavy.length >= 3) {
    suggestions.push({
      kind: 'subagent',
      reason: `${heavy.length} tool results exceed 500 tokens each. Move noisy bulk work (log triage, large scans) into a subagent that returns only a short report.`,
    })
  }

  if (pressurePercent !== null && pressurePercent < 50) {
    suggestions.push({
      kind: 'continue',
      reason: `Context is healthy at ${pressurePercent}% pressure; no action needed.`,
    })
  }

  if (compactionCount > 0) {
    suggestions.push({
      kind: 'feedback',
      reason: `Compaction ran ${compactionCount} time(s) and removed ~${totalCompactionSaved} tokens from the surface.`,
    })
  }

  return suggestions
}
