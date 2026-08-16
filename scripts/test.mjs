/**
 * Cross-version test runner.
 *
 * `node --test` accepted glob patterns only from Node 21+ and directory args
 * behave inconsistently across versions (Node 20 recurses a directory, Node 24
 * treats a bare directory as a module path). This script collects every
 * `*.test.js` under `src/` explicitly and spawns `node --test` with the exact
 * file list, so `npm test` behaves identically on Node 20, 22 and 24.
 *
 * @module dsh-token-slim/scripts/test
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Collect every *.test.js file under a directory, recursively.
 * @param {string} dir
 * @returns {string[]}
 */
function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...collect(path))
    else if (entry.endsWith('.test.js')) out.push(path)
  }
  return out
}

const files = collect(join(root, 'src'))
if (files.length === 0) {
  console.error('test: no *.test.js files found under src/')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: root,
})
process.exit(result.status ?? 1)
