/**
 * Tests for the selective-context retention decision.
 * @module dsh-token-slim/selective-context/retention.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isDropCandidate, selectRetention } from './retention.js'

const NOISY_TEXT = Array.from({ length: 30 }, (_, i) => `  PASS  suite/case${i} (${i} ms)`).join('\n')
const MIXED_TEXT = `${NOISY_TEXT}\n  FAIL  suite/broken (1 ms)`

test('drops only old, large, overwhelmingly-noise results', () => {
  const candidate = {
    tokens: 4000,
    turn: 1,
    text: NOISY_TEXT,
  }
  assert.equal(
    isDropCandidate(candidate, { currentTurn: 6, minTokens: 2000, minAgeTurns: 3, noiseRatioThreshold: 0.95 }),
    true,
  )
})

test('keeps results with any high-value content', () => {
  const candidate = { tokens: 4000, turn: 1, text: MIXED_TEXT }
  assert.equal(
    isDropCandidate(candidate, { currentTurn: 6, minTokens: 2000, minAgeTurns: 3, noiseRatioThreshold: 0.95 }),
    false,
  )
})

test('keeps young or small results', () => {
  const young = { tokens: 4000, turn: 5, text: NOISY_TEXT }
  const small = { tokens: 100, turn: 1, text: NOISY_TEXT }
  assert.equal(isDropCandidate(young, { currentTurn: 6, minTokens: 2000, minAgeTurns: 3 }), false)
  assert.equal(isDropCandidate(small, { currentTurn: 6, minTokens: 2000, minAgeTurns: 3 }), false)
})

test('never drops a message whose shape it cannot read', () => {
  assert.equal(isDropCandidate({ tokens: 9000, turn: 0 }, { currentTurn: 9 }), false)
  assert.equal(isDropCandidate({ tokens: 9000, turn: 0, text: '' }, { currentTurn: 9 }), false)
  assert.equal(isDropCandidate(null), false)
})

test('selectRetention partitions candidates', () => {
  const candidates = [
    { tokens: 4000, turn: 0, text: NOISY_TEXT },
    { tokens: 4000, turn: 0, text: MIXED_TEXT },
    { tokens: 500, turn: 0, text: NOISY_TEXT },
  ]
  const { drop, keep } = selectRetention(candidates, {
    currentTurn: 5,
    minTokens: 2000,
    minAgeTurns: 3,
    noiseRatioThreshold: 0.95,
  })
  assert.equal(drop.length, 1)
  assert.equal(keep.length, 2)
})
