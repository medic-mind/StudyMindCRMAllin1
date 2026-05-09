// Status summary regenerator. CLAUDE.md §17.1 (every 30 min for changed
// contacts), §18 (AI-heavy → concurrency limit 3), §42.3 (restricted-access
// contacts are excluded from AI inputs).
//
// Walks Contacts whose latest interaction is newer than the last summary
// generation, runs the status-summary prompt against a slim, redacted
// context, and upserts ContactStatusSummary.

import {
  buildStatusSummaryPrompt,
  runStructured,
  statusSummarySchema,
  STATUS_SUMMARY_PROMPT_VERSION,
  type ContactContext,
} from '@studymind/ai'
import { db } from '@studymind/db'

import { inngest } from '../client'

/** Tunable: how many candidate contacts to refresh per run. */
const BATCH_LIMIT = 100

/** How many recent Interactions to feed the prompt. */
const RECENT_INTERACTION_LIMIT = 30

interface CandidateRow {
  contactId: string
  lastInteractionAt: Date
}

/**
 * List Contacts whose lastInteractionAt is newer than the
 * ContactStatusSummary.generatedAt (or who have no summary yet). Excludes
 * restricted_access contacts (CLAUDE.md §42.3) and soft-deleted contacts.
 */
async function listChangedContacts(): Promise<CandidateRow[]> {
  // Latest interaction per contact in one query, then anti-join on summary.
  // This is a recurring 30-min job; capping the candidate set keeps it
  // bounded. We do not page; the next tick picks up the rest.
  const restricted = await db.safeguardingFlag.findMany({
    where: { state: 'restricted_access', deletedAt: null },
    select: { contactId: true },
  })
  const restrictedIds = new Set(restricted.map((r) => r.contactId))

  const recent = await db.interaction.findMany({
    where: {
      deletedAt: null,
      contactId: { not: null },
    },
    orderBy: { occurredAt: 'desc' },
    select: { contactId: true, occurredAt: true },
    take: 5_000,
  })

  // Reduce to the latest occurredAt per contact.
  const latestByContact = new Map<string, Date>()
  for (const row of recent) {
    if (!row.contactId) continue
    if (restrictedIds.has(row.contactId)) continue
    if (!latestByContact.has(row.contactId)) {
      latestByContact.set(row.contactId, row.occurredAt)
    }
  }

  if (latestByContact.size === 0) return []

  const summaries = await db.contactStatusSummary.findMany({
    where: { contactId: { in: Array.from(latestByContact.keys()) } },
    select: { contactId: true, generatedAt: true },
  })
  const summaryByContact = new Map(summaries.map((s) => [s.contactId, s.generatedAt]))

  const candidates: CandidateRow[] = []
  for (const [contactId, lastInteractionAt] of latestByContact) {
    const generatedAt = summaryByContact.get(contactId)
    if (!generatedAt || generatedAt < lastInteractionAt) {
      candidates.push({ contactId, lastInteractionAt })
    }
    if (candidates.length >= BATCH_LIMIT) break
  }
  return candidates
}

async function buildContext(contactId: string): Promise<ContactContext | null> {
  const contact = await db.contact.findUnique({
    where: { id: contactId, deletedAt: null },
    select: {
      firstName: true,
      kind: true,
      familyMembers: { select: { familyId: true } },
    },
  })
  if (!contact) return null

  const familyIds = contact.familyMembers.map((m) => m.familyId)

  const interactions = await db.interaction.findMany({
    where: { contactId, deletedAt: null },
    orderBy: { occurredAt: 'desc' },
    take: RECENT_INTERACTION_LIMIT,
    select: { type: true, occurredAt: true, summary: true },
  })

  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      status: { in: ['open', 'in_progress', 'blocked'] },
      OR: [{ contactId }, ...(familyIds.length > 0 ? [{ familyId: { in: familyIds } }] : [])],
    },
    select: { title: true, dueAt: true },
    take: 10,
  })

  const discrepancies =
    familyIds.length > 0
      ? await db.reconciliationDiscrepancy.findMany({
          where: { familyId: { in: familyIds }, resolvedAt: null },
          select: { category: true, summary: true },
          take: 10,
        })
      : []

  const safeguardingFlag = await db.safeguardingFlag.findFirst({
    where: { contactId, deletedAt: null, state: { not: 'none' } },
    select: { id: true },
  })

  return {
    firstName: contact.firstName,
    kind: contact.kind,
    recentInteractions: interactions.map((i) => ({
      type: i.type,
      occurredAt: i.occurredAt.toISOString(),
      brief: i.summary ?? '',
    })),
    openTasks: tasks.map((t) => ({
      title: t.title,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    })),
    openDiscrepancies: discrepancies.map((d) => ({
      category: d.category,
      summary: d.summary,
    })),
    hasSafeguardingFlag: Boolean(safeguardingFlag),
  }
}

export const aiRegenerateStatusSummaries = inngest.createFunction(
  {
    id: 'ai/regenerate-status-summaries',
    name: 'AI: regenerate Current Status header for changed contacts',
    // §18: AI-heavy. Cap concurrency.
    concurrency: { limit: 3 },
    retries: 3,
  },
  { cron: '*/30 * * * *' },
  async ({ step, logger }) => {
    const candidates = await step.run('list-changed-contacts', async () => {
      return listChangedContacts()
    })

    let regenerated = 0
    for (const candidate of candidates) {
      const result = await step.run(`summarise-${candidate.contactId}`, async () => {
        const ctx = await buildContext(candidate.contactId)
        if (!ctx) return { skipped: true as const, reason: 'contact_gone' }

        const prompt = buildStatusSummaryPrompt({ context: ctx })
        const summary = await runStructured({
          task: 'status_summary',
          promptVersion: prompt.promptVersion,
          schema: statusSummarySchema,
          schemaName: 'StatusSummary',
          system: prompt.system,
          user: prompt.user,
          model: 'gpt-4o-mini',
          contactId: candidate.contactId,
          ctx: { contactId: candidate.contactId },
        })

        const now = new Date()
        await db.contactStatusSummary.upsert({
          where: { contactId: candidate.contactId },
          create: {
            contactId: candidate.contactId,
            headerLine: summary.headerLine,
            bodyLine: summary.bodyLine,
            generatedAt: now,
            promptVersion: STATUS_SUMMARY_PROMPT_VERSION,
          },
          update: {
            headerLine: summary.headerLine,
            bodyLine: summary.bodyLine,
            generatedAt: now,
            promptVersion: STATUS_SUMMARY_PROMPT_VERSION,
          },
        })
        return { skipped: false as const }
      })
      if (!result.skipped) regenerated += 1
    }

    logger.info(
      { candidates: candidates.length, regenerated },
      'ai.status_summary.completed',
    )
    return { candidates: candidates.length, regenerated }
  },
)

export const STATUS_SUMMARY_FUNCTIONS = [aiRegenerateStatusSummaries] as const
