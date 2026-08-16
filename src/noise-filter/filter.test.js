/**
 * Tests for the noise-filter compression core.
 * @module dsh-token-slim/noise-filter/filter.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyCommand, compressBashResult, compressText } from './filter.js'

const PASS_LINES = Array.from({ length: 40 }, (_, i) => `  PASS  src/foo${i}.test.ts (${i + 1} ms)`)
const FAIL_LINES = [
  '  FAIL  src/bar.test.ts',
  '  ✗ fails when the input is empty (12 ms)',
  '    AssertionError: expected 1 to equal 2',
  '    at src/bar.test.ts:14:5',
]
const SUMMARY = [' Test Files  2 failed | 40 passed (42)', ' Tests       1 failed | 399 passed (400)']
const NOISY_TEST_OUTPUT = [...PASS_LINES, ...FAIL_LINES, ...SUMMARY].join('\n')

test('classifyCommand detects test runners', () => {
  assert.equal(classifyCommand('npx vitest run --reporter=dot'), 'test')
  assert.equal(classifyCommand('npm test -- --watch'), 'test')
  assert.equal(classifyCommand('go test ./...'), 'test')
  assert.equal(classifyCommand('pytest -q'), 'test')
  assert.equal(classifyCommand('git log --oneline -20'), 'git')
  assert.equal(classifyCommand('npm install --no-progress'), 'build')
  assert.equal(classifyCommand('find . -name "*.ts"'), 'list')
  assert.equal(classifyCommand('echo hello'), null)
})

test('compressText drops PASS lines and keeps failures and summary', () => {
  const out = compressText(NOISY_TEST_OUTPUT, {
    minChars: 100,
    minSavingsChars: 100,
    headLines: 2,
    tailLines: 2,
  })
  assert.ok(out !== null, 'expected a rewrite')
  assert.ok(out.stats.suppressedLines >= 30, 'most PASS lines suppressed')
  assert.ok(out.text.includes('FAIL  src/bar.test.ts'), 'failure kept')
  assert.ok(out.text.includes('AssertionError'), 'assertion kept')
  assert.ok(out.text.includes('Test Files'), 'summary kept')
  assert.ok(out.text.includes('at src/bar.test.ts:14:5'), 'stack frame kept')
  assert.ok(out.text.includes('dsh-token-slim'), 'marker present')
})

test('compressText returns null when savings are below threshold', () => {
  const out = compressText('  PASS  a.test.ts (1 ms)\n  PASS  b.test.ts (2 ms)\n', {
    minChars: 1,
    minSavingsChars: 10_000,
  })
  assert.equal(out, null)
})

test('compressText returns null for high-value content only', () => {
  const out = compressText('FAIL: everything broke\nERROR: boom\n', {
    minChars: 1,
    minSavingsChars: 0,
  })
  assert.equal(out, null, 'nothing suppressible, nothing rewritten')
})

test('compressText preserves the exit-relevant tail (git head/tail)', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `commit abc${i} subject ${i}`)
  const out = compressText(lines.join('\n'), {
    minChars: 100,
    minSavingsChars: 100,
    headLines: 3,
    tailLines: 2,
  })
  assert.ok(out !== null)
  const keptLines = out.text.split('\n')
  assert.ok(keptLines.some((line) => line.includes('subject 0')), 'head kept')
  assert.ok(keptLines.some((line) => line.includes('subject 59')), 'tail kept')
})

test('compressBashResult applies class policy and honors enableClasses', () => {
  const big = ['ok 1 - works', 'ok 2 - works', 'ok 3 - works']
    .concat(Array.from({ length: 50 }, (_, i) => `test case ${i} ... ok`))
    .join('\n')
  const out = compressBashResult('cargo test', big, { minChars: 50, minSavingsChars: 50 })
  assert.ok(out !== null)
  assert.equal(compressBashResult('cargo test', big, { enableClasses: ['build'] }), null)
  assert.equal(compressBashResult('echo hi', 'x'.repeat(5000), { minChars: 1 }), null)
})
