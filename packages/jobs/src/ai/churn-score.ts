// Nightly churn risk scorer. CLAUDE.md §17.1, §17.3 (waits for
// finance/reconcile.completed), §18 (AI mini-task, concurrency 3).
//
// For each active Family: build a slim signal vector, run the churn-score
// prompt, persist a ChurnScore row, mirror the score onto the Family, and
// recompute the at-risk derivation (CLAUDE.md §6.4). The high-risk families
// surface on the at-risk dashboard for a human to action.

import { createId } from '@paralleldrive/cuid2'

import {
  buildChurnScorePrompt,
  CHURN_SCORE_PROMPT_VERSION,
  churnScoreSchema,
  runStructured,
  type ChurnSignals,
} from '@studymind/ai'
import { recomputeAtRiskForFamily } from '@studymind/core/finance'
import { db } from '@studymind/db'

import { inngest } from '../client'

const ACTIVE_STATES = ['trial', 'active', 'at_risk'] as const

async function buildSignals(familyId: string, now: Date): Promise<ChurnSignals> {
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)

  const family = await db.family.findUniqueOrThrow({
    where: { id: familyId },
    select: {
      state: true,
    },
  })

  const lastInteraction = await db.interaction.findFirst({
    where: { familyId, deletedAt: null },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  })

  const daysSinceLastInteraction = lastInteraction
    ? Math.floor((now.getTime() - lastInteraction.occurredAt.getTime()) / (1000 * 60 * 60 * 24))
    : 365

  const paymentFailuresLast60d = await db.payment.count({
    where: {
      familyId,
      receivedAt: { gte: sixtyDaysAgo },
      reverted: true,
    },
  })

  const missedSessionsLast60d = await db.bookingSession.count({
    where: {
      booking: { familyId },
      scheduledAt: { gte: sixtyDaysAgo },
      state: { in: ['no_show', 'cancelled'] },
      deletedAt: null,
    },
  })

  const openDiscrepancies = await db.reconciliationDiscrepancy.count({
    where: { familyId, resolvedAt: null },
  })

  return {
    daysSinceLastInteraction,
    paymentFailuresLast60d,
    missedSessionsLast60d,
    // Sentiment-from-inbound is built in a later slice; null is acceptable.
    sentimentMean: null,
    state: family.state,
    openDiscrepancies,
  }
}

export const aiScoreChurnRisk = inngest.createFunction(
  {
    id: 'ai/score-churn-risk',
    name: 'AI: score churn risk after nightly reconciliation',
    concurrency: { limit: 3 },
    retries: 3,
  },
  { event: 'finance/reconcile.completed' },
  async ({ step, logger }) => {
    const families = await step.run('list-active-families', async () => {
      return db.family.findMany({
        where: { state: { in: [...ACTIVE_STATES] }, deletedAt: null },
        select: { id: true },
        take: 5_000,
      })
    })

    let scored = 0

    for (const family of families) {
      const result = await step.run(`score-${family.id}`, async () => {
        const now = new Date()
        const signals = await buildSignals(family.id, now)
        const prompt = buildChurnScorePrompt({ signals })
        const out = await runStructured({
          task: 'churn_score',
          promptVersion: prompt.promptVersion,
          schema: churnScoreSchema,
          schemaName: 'ChurnScore',
          system: prompt.system,
          user: prompt.user,
          model: 'gpt-4o-mini',
          ctx: { familyId: family.id },
        })

        await db.churnScore.create({
          data: {
            id: createId(),
            familyId: family.id,
            score: out.score,
            drivers: out.drivers,
            rationale: out.rationale,
            scoredAt: now,
            promptVersion: CHURN_SCORE_PROMPT_VERSION,
          },
        })

        // Mirror the score onto the Family for fast filtering on dashboards.
        await db.family.update({
          where: { id: family.id },
          data: { churnScore: out.score },
        })

        // Recompute at-risk derivation now that a fresh churn score has
        // landed. CLAUDE.md §6.4. Idempotent — only writes on transition.
        await recomputeAtRiskForFamily(db, family.id, {
          requestId: `churn:${family.id}:${now.toISOString().slice(0, 10)}`,
        })

        return { scored: true as const }
      })
      if (result.scored) scored += 1
    }

    logger.info({ families: families.length, scored }, 'ai.churn_score.completed')
    return { families: families.length, scored }
  },
)

export const CHURN_SCORE_FUNCTIONS = [aiScoreChurnRisk] as const
