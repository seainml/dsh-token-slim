/**
 * Tests for the context-audit report builder.
 * @module dsh-token-slim/context-audit/audit.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAuditReport, buildSuggestions } from './audit.js'

const measurement = {
  totalTokens: 180_000,
  surfaceTokens: 120_000,
  nodes: [
    { seq: 1, tokens: 10_000 },
    { seq: 2, tokens: 2_000 },
    { seq: 3, tokens: 500 },
    { seq: 4, tokens: 50_000 },
  ],
}

test('buildAuditReport computes pressure and top offenders', () => {
  const report = buildAuditReport(measurement, { contextLimitTokens: 200_000 })
  assert.equal(report.pressurePercent, 90)
  assert.equal(report.totalTokens, 180_000)
  assert.equal(report.surfaceTokens, 120_000)
  assert.equal(report.topOffenders[0].seq, 4)
  assert.equal(report.topOffenders[0].percentOfSurface, 41.7)
})

test('pressure above 80% yields a compact suggestion with an estimate', () => {
  const report = buildAuditReport(measurement, { contextLimitTokens: 200_000 })
  const compact = report.suggestions.find((s) => s.kind === 'compact')
  assert.ok(compact, 'compact suggestion present')
  assert.equal(compact.estimatedSavingsTokens, Math.round(120_000 * 0.6))
})

test('large offenders trigger a prune suggestion', () => {
  const report = buildAuditReport(measurement, { contextLimitTokens: 200_000 })
  const prune = report.suggestions.find((s) => s.kind === 'prune')
  assert.ok(prune, 'prune suggestion present')
  assert.ok(prune.reason.includes('50,000') || prune.estimatedSavingsTokens === 35_000)
})

test('healthy context yields a continue suggestion and no compact', () => {
  const report = buildAuditReport(
    { totalTokens: 20_000, surfaceTokens: 12_000, nodes: [{ seq: 1, tokens: 1_000 }] },
    { contextLimitTokens: 200_000 },
  )
  assert.ok(report.suggestions.some((s) => s.kind === 'continue'))
  assert.ok(!report.suggestions.some((s) => s.kind === 'compact'))
})

test('compaction history is aggregated and reported', () => {
  const report = buildAuditReport(measurement, {
    contextLimitTokens: 200_000,
    compactionHistory: [
      { savedTokens: 30_000, at: 1 },
      { savedTokens: 12_000, at: 2 },
    ],
  })
  assert.equal(report.compaction.count, 2)
  assert.equal(report.compaction.totalSavedTokens, 42_000)
  assert.ok(report.suggestions.some((s) => s.kind === 'feedback'))
})

test('long sessions trigger a clear suggestion', () => {
  const suggestions = buildSuggestions({
    pressurePercent: 55,
    surfaceTokens: 10_000,
    totalTokens: 20_000,
    topOffenders: [],
    turns: 50,
    compactionCount: 0,
    totalCompactionSaved: 0,
  })
  assert.ok(suggestions.some((s) => s.kind === 'clear'))
})
