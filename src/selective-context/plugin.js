/**
 * selective-context plugin: conservative selective retention at step time.
 *
 * Hooks the `agent/pre-step` waterfall. When the session's projected pressure
 * is above `pressureThresholdTokens`, it filters *tool-result* messages older
 * than `minAgeTurns` that qualify as low-value noise (see retention.js). The
 * plugin is **disabled by default**: it is an experimental optimization and any
 * history removal carries risk. Enable it explicitly and validate on your own
 * workloads.
 *
 * @module dsh-token-slim/selective-context
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { selectRetention } from './retention.js'

export const name = 'selective-context'

export class SelectiveContext extends Service {
  static inject = ['tokenMeter']

  static Config = z.object({
    /** Master switch; the plugin does nothing until this is true. */
    enabled: z.boolean().default(false),
    /** Projected surface (tokens) above which filtering is considered. */
    pressureThresholdTokens: z.number().integer().min(1).default(150_000),
    /** Only tool results above this size may be dropped. */
    minTokens: z.number().integer().min(0).default(2000),
    /** Only tool results older than this many turns may be dropped. */
    minAgeTurns: z.number().integer().min(0).default(3),
    /** Minimum fraction of noise-class lines for a result to be droppable. */
    noiseRatioThreshold: z.number().min(0).max(1).default(0.95),
    /** Cap on how many messages one step may drop. */
    maxDropPerStep: z.number().integer().min(1).default(2),
  })

  /**
   * @param {Context} ctx
   * @param {object} config
   */
  constructor(ctx, config = {}) {
    super(ctx, 'selectiveContext')

    this.config = {
      enabled: config.enabled ?? false,
      pressureThresholdTokens: config.pressureThresholdTokens ?? 150_000,
      minTokens: config.minTokens ?? 2000,
      minAgeTurns: config.minAgeTurns ?? 3,
      noiseRatioThreshold: config.noiseRatioThreshold ?? 0.95,
      maxDropPerStep: config.maxDropPerStep ?? 2,
    }

    ctx.on('agent/pre-step', (payload, next) => this.handlePreStep(payload, next))
  }

  /**
   * agent/pre-step waterfall listener.
   * @param {{ agent: import('@deepseek-ai/dsh-agent').Agent; messages: unknown[]; turn: number; step: number; signal: AbortSignal }} payload
   * @param {() => Promise<import('@deepseek-ai/dsh-agent-loop').PreStepDecision>} next
   * @returns {Promise<import('@deepseek-ai/dsh-agent-loop').PreStepDecision>}
   */
  async handlePreStep(payload, next) {
    if (!this.config.enabled) return next()
    try {
      const decision = await this.filterMessages(payload)
      if (decision === null) return next()
      return decision
    } catch {
      // Never break the agent loop because filtering failed.
      return next()
    }
  }

  /**
   * @param {{ agent: import('@deepseek-ai/dsh-agent').Agent; messages: unknown[]; turn: number }} payload
   * @returns {Promise<import('@deepseek-ai/dsh-agent-loop').PreStepDecision | null>}
   */
  async filterMessages(payload) {
    const agent = payload.agent
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    if (measurement.surfaceTokens < this.config.pressureThresholdTokens) return null

    const candidates = payload.messages
      .map((message, index) => ({
        index,
        turn: typeof message.turn === 'number' ? message.turn : payload.turn,
        tokens: estimateMessageTokens(message),
        text: messageText(message),
      }))
      .filter((candidate) => candidate.text !== null)

    const { drop } = selectRetention(candidates, {
      currentTurn: payload.turn,
      minTokens: this.config.minTokens,
      minAgeTurns: this.config.minAgeTurns,
      noiseRatioThreshold: this.config.noiseRatioThreshold,
    })

    const toDrop = drop.slice(0, this.config.maxDropPerStep)
    if (toDrop.length === 0) return null

    const dropIndexes = new Set(toDrop.map((candidate) => candidate.index))
    const filtered = payload.messages.filter((message, index) => !dropIndexes.has(index))
    const droppedTokens = toDrop.reduce((sum, candidate) => sum + candidate.tokens, 0)

    const reason = `selective-context: dropped ${toDrop.length} stale low-value tool result(s) (~${droppedTokens} tokens) to keep the step within budget.`
    if (typeof this.ctx.logger?.info === 'function') {
      this.ctx.logger.info(reason)
    }
    return { kind: 'enter', messages: filtered }
  }
}

/**
 * Estimate the heuristic token size of a message from its text content.
 * Mirrors the token-meter's rough 4-char-per-token heuristic for text.
 * @param {unknown} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
  const text = messageText(message)
  if (text === null) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Extract the combined text of a message's content blocks, or null when the
 * message shape is unexpected (never drop what we cannot read).
 * @param {unknown} message
 * @returns {string | null}
 */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return null
  const content = message.content
  if (!Array.isArray(content)) return null
  let text = ''
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text + '\n'
    }
  }
  return text === '' ? null : text
}

export default SelectiveContext
