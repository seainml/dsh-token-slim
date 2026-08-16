/**
 * context-audit plugin: token health audit + compaction feedback loop.
 *
 * Registers a model-visible tool (`token_audit`) that reports current context
 * pressure, the largest tool-result offenders, and actionable suggestions. It
 * also listens to durable `compaction/summary` session events to track how many
 * tokens each compaction actually removed — the feedback loop that makes token
 * hygiene observable.
 *
 * @module dsh-token-slim/context-audit
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { buildAuditReport } from './audit.js'

export const name = 'context-audit'

export class ContextAudit extends Service {
  static inject = ['tools', 'tokenMeter']

  static Config = z.object({
    /** Assumed model context limit used to compute pressure percentages. */
    contextLimitTokens: z.number().integer().min(1).default(200_000),
    /** How many top offender nodes the report lists. */
    topOffenders: z.number().integer().min(1).max(50).default(8),
    /** Name of the registered model tool. */
    toolName: z.string().default('token_audit'),
    /** Track `compaction/summary` events and report cumulative savings. */
    trackCompaction: z.boolean().default(true),
    /** Cap on the retained in-memory compaction history. */
    maxCompactionHistory: z.number().integer().min(0).default(10),
  })

  /**
   * @param {Context} ctx
   * @param {object} config
   */
  constructor(ctx, config = {}) {
    super(ctx, 'contextAudit')

    this.toolName = config.toolName ?? 'token_audit'
    this.contextLimitTokens = config.contextLimitTokens ?? 200_000
    this.topOffenders = config.topOffenders ?? 8
    this.trackCompaction = config.trackCompaction ?? true
    this.maxCompactionHistory = config.maxCompactionHistory ?? 10

    /** @type {Array<{ savedTokens: number; at: number }>} */
    this.compactionHistory = []
    this.turnCount = 0

    if (this.trackCompaction) {
      ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
    }
    ctx.on('agent/turn-stopping', (payload) => {
      this.turnCount = Math.max(this.turnCount, payload.turn)
    })

    ctx.tools.register(this.buildToolDefinition())
  }

  /**
   * Track compaction savings from durable session events.
   * `compaction/summary` carries `shadowedTokenCount` — the heuristic token
   * count of the span that was replaced by the summary.
   * @param {unknown} session
   * @param {{ type: string; data: { shadowedTokenCount?: number } }} event
   */
  onSessionEvent(session, event) {
    if (event.type !== 'compaction/summary') return
    const savedTokens = event.data.shadowedTokenCount ?? 0
    this.compactionHistory.push({ savedTokens, at: Date.now() })
    if (this.compactionHistory.length > this.maxCompactionHistory) {
      this.compactionHistory.shift()
    }
  }

  /**
   * Build the `token_audit` tool definition.
   * @returns {object} a full ToolDefinition for ctx.tools.register().
   */
  buildToolDefinition() {
    return {
      name: this.toolName,
      description:
        'Audit the current session context: token pressure, the largest tool-result offenders, compaction savings, and actionable suggestions. Returns a structured report.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            totalTokens: { type: 'number' },
            surfaceTokens: { type: 'number' },
            pressurePercent: { type: ['number', 'null'] },
            contextLimitTokens: { type: 'number' },
            turns: { type: 'number' },
            topOffenders: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  seq: { type: 'number' },
                  tokens: { type: 'number' },
                  percentOfSurface: { type: 'number' },
                },
                required: ['seq', 'tokens', 'percentOfSurface'],
                additionalProperties: false,
              },
            },
            compaction: {
              type: 'object',
              properties: {
                count: { type: 'number' },
                totalSavedTokens: { type: 'number' },
              },
              required: ['count', 'totalSavedTokens'],
              additionalProperties: false,
            },
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string' },
                  reason: { type: 'string' },
                  estimatedSavingsTokens: { type: ['number', 'null'] },
                },
                required: ['kind', 'reason'],
                additionalProperties: false,
              },
            },
          },
          required: [
            'totalTokens',
            'surfaceTokens',
            'pressurePercent',
            'contextLimitTokens',
            'turns',
            'topOffenders',
            'compaction',
            'suggestions',
          ],
          additionalProperties: false,
        },
        render: (args, value) => [{ type: 'text', text: renderReport(value) }],
      },
      execute: async (args, exec) => this.executeAudit(exec),
    }
  }

  /**
   * Execute one audit for the calling agent.
   * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec
   * @returns {Promise<object>} the JSON-safe report.
   */
  async executeAudit(exec) {
    const agent = exec.agent
    if (agent === undefined) {
      return {
        error: 'token_audit: no owning agent on this execution.',
      }
    }
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    return buildAuditReport(
      {
        totalTokens: measurement.totalTokens,
        surfaceTokens: measurement.surfaceTokens,
        nodes: measurement.nodes,
      },
      {
        contextLimitTokens: this.contextLimitTokens,
        topOffenders: this.topOffenders,
        compactionHistory: this.compactionHistory,
        turns: this.turnCount,
      },
    )
  }
}

/**
 * Human-readable rendering of the audit report for the conversation.
 * @param {object} report
 * @returns {string}
 */
export function renderReport(report) {
  const lines = []
  const pct = report.pressurePercent === null ? 'unknown' : `${report.pressurePercent}%`
  lines.push(`token_audit: pressure ${pct} (${report.totalTokens} total, ${report.surfaceTokens} surface tokens, limit ${report.contextLimitTokens})`)
  lines.push(`turns: ${report.turns}; compaction runs: ${report.compaction.count} (${report.compaction.totalSavedTokens} tokens removed)`)
  if (report.topOffenders.length > 0) {
    lines.push('top tool-result offenders:')
    for (const node of report.topOffenders) {
      lines.push(`  seq ${node.seq}: ~${node.tokens} tokens (${node.percentOfSurface}% of surface)`)
    }
  }
  if (report.suggestions.length > 0) {
    lines.push('suggestions:')
    for (const suggestion of report.suggestions) {
      const savings =
        suggestion.estimatedSavingsTokens === undefined
          ? ''
          : ` (~${suggestion.estimatedSavingsTokens} tokens)`
      lines.push(`  - [${suggestion.kind}] ${suggestion.reason}${savings}`)
    }
  }
  return lines.join('\n')
}

export default ContextAudit
