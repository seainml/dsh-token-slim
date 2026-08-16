/**
 * noise-filter plugin: command-aware tool-result compression.
 *
 * Hooks the `tools/post-execute` waterfall and rewrites the model-facing
 * content of successful `bash` results that belong to a known noisy command
 * class (test runners, build tools, git, listing). The pipeline is never
 * broken: any failure inside the filter falls back to the downstream decision.
 *
 * @module dsh-token-slim/noise-filter
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_KEEP_PATTERNS, DEFAULT_NOISE_PATTERNS } from '../lib/lines.js'
import { COMMAND_CLASSES, compressBashResult, DEFAULT_MARKER } from './filter.js'

export const name = 'noise-filter'

export class NoiseFilter extends Service {
  static inject = []

  static Config = z.object({
    /** Tool names whose results may be rewritten. */
    applyToTools: z.array(z.string()).default(['bash']),
    /** Command classes to enable. */
    enableClasses: z
      .array(z.string())
      .default(COMMAND_CLASSES.map((cls) => cls.id)),
    /** Minimum raw text length before a rewrite is considered. */
    minChars: z.number().integer().min(0).default(2000),
    /** Minimum character savings for a rewrite to be applied. */
    minSavingsChars: z.number().integer().min(0).default(500),
    /** Head/tail retention for ambiguous lines. */
    headLines: z.number().integer().min(0).default(10),
    tailLines: z.number().integer().min(0).default(10),
    /** Marker appended to rewritten output. */
    marker: z.string().default(DEFAULT_MARKER),
    /** Extra keep patterns (regex source strings), appended to the defaults. */
    keepPatterns: z.array(z.string()).default([]),
    /** Extra noise patterns (regex source strings), appended to the defaults. */
    noisePatterns: z.array(z.string()).default([]),
  })

  /**
   * @param {Context} ctx
   * @param {import('./filter.js').FilterConfig} config
   */
  constructor(ctx, config = {}) {
    super(ctx, 'noiseFilter')

    const keep = [
      ...DEFAULT_KEEP_PATTERNS,
      ...(config.keepPatterns ?? []).map((source) => new RegExp(source, 'i')),
    ]
    const noise = [
      ...DEFAULT_NOISE_PATTERNS,
      ...(config.noisePatterns ?? []).map((source) => new RegExp(source, 'i')),
    ]

    this.filterConfig = {
      applyToTools: config.applyToTools ?? ['bash'],
      enableClasses: config.enableClasses ?? COMMAND_CLASSES.map((cls) => cls.id),
      minChars: config.minChars ?? 2000,
      minSavingsChars: config.minSavingsChars ?? 500,
      headLines: config.headLines ?? 10,
      tailLines: config.tailLines ?? 10,
      marker: config.marker ?? DEFAULT_MARKER,
      keep,
      noise,
    }

    ctx.on('tools/post-execute', (exec, result, next) =>
      this.handlePostExecute(exec, result, next),
    )
  }

  /**
   * tools/post-execute waterfall listener.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
   * @param {Readonly<import('@deepseek-ai/dsh-tools').ToolExecutionResult>} result
   * @param {() => Promise<import('@deepseek-ai/dsh-tools').PostToolDecision>} next
   * @returns {Promise<import('@deepseek-ai/dsh-tools').PostToolDecision>}
   */
  async handlePostExecute(exec, result, next) {
    const decision = await next()
    if (!this.filterConfig.applyToTools.includes(exec.name)) return decision
    // Accept regardless of whether the downstream decision carried content: a
    // content-less accept keeps the original result, which we may still replace.
    if (decision.kind !== 'accept' || decision.value !== undefined) return decision
    if (result.isError) return decision
    try {
      const rewritten = this.rewriteResultContent(exec, result)
      if (rewritten === null) return decision
      return { ...decision, content: rewritten }
    } catch {
      // Never break the pipeline because the filter itself failed.
      return decision
    }
  }

  /**
   * Rewrite the text blocks of a successful result, or return null when the
   * rewrite is not worthwhile.
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
   * @param {import('@deepseek-ai/dsh-tools').ToolExecutionSuccess} result
   * @returns {import('@deepseek-ai/dsh-llm').ContentBlock[] | null}
   */
  rewriteResultContent(exec, result) {
    const command =
      exec.name === 'bash' ? String(exec.arguments?.command ?? '') : ''
    if (command === '') return null

    let changed = false
    const content = result.content.map((block) => {
      if (block.type !== 'text') return block
      const out = compressBashResult(command, block.text, this.filterConfig)
      if (out === null) return block
      changed = true
      return { ...block, text: out.text }
    })
    return changed ? content : null
  }
}

export default NoiseFilter
