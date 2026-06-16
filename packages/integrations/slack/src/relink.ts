// Automated triage for parked Slack mentions (ADR 0034 amendment).
//
// A mention only parks in `UnassignedSummary` when the matcher couldn't resolve
// it to ONE contact at ingest time — often because the contact didn't exist yet,
// or the message named someone by first name only. Nothing used to retry those
// rows, so the tray only ever grew and "zero customers" showed Slack mentions.
//
// This recurring job re-runs the (now smarter) shared matcher over every open
// row and auto-links the unambiguous ones, resolving the row. It is FREE — it
// reuses the AI extraction already stored on the row plus a deterministic
// email/phone scan of the original text; it never calls the AI again. Ambiguous
// rows stay in the tray for a human (§3 — never guess between two same-named
// people, never auto-create a contact).

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { extractIdentifiersFromText, matchContactByCandidate } from './match'
import { buildSlackPermalink } from './permalink'

/** The slice of an `UnassignedSummary.parsed` blob the relink needs. */
export interface ParsedCandidate {
  name: string | null
  email: string | null
  phone: string | null
  summary: string | null
  category: string | null
  sentiment: string | null
  suggestedNextAction: string | null
  promptVersion: string | null
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

/** Read the stored AI extraction off a parked row (defensive — the JSON shape
 *  is the slack-summary prompt output, but a row may predate a field). */
export function candidateFromParsed(parsed: unknown): ParsedCandidate {
  const p = (parsed ?? {}) as Record<string, unknown>
  const cand = (p['candidateContactIdentifier'] ?? {}) as Record<string, unknown>
  return {
    name: str(cand['name']),
    email: str(cand['email']),
    phone: str(cand['phone']),
    summary: str(p['summary']),
    category: str(p['category']),
    sentiment: str(p['sentiment']),
    suggestedNextAction: str(p['suggestedNextAction']),
    promptVersion: str(p['promptVersion']),
  }
}

/** How many open rows to scan per tick — bounded so a large backlog drains over
 *  a few ticks rather than in one long transaction. */
export const RELINK_BATCH = 200

export const slackRelinkUnassigned = inngest.createFunction(
  {
    id: 'slack/relink-unassigned',
    name: 'Auto-link parked Slack mentions to contacts',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '*/30 * * * *' },
  async ({ step, logger }) => {
    const result = await step.run('relink', async () => {
      const rows = await db.unassignedSummary.findMany({
        where: { resolvedAt: null },
        orderBy: { createdAt: 'asc' },
        take: RELINK_BATCH,
        select: {
          id: true,
          slackTs: true,
          channelId: true,
          parsed: true,
          confidence: true,
          messageText: true,
          senderName: true,
          createdAt: true,
        },
      })

      let linked = 0
      for (const row of rows) {
        const cand = candidateFromParsed(row.parsed)
        // Merge the stored AI candidate with a fresh deterministic scan of the
        // original message (catches an email/phone the first pass missed, and
        // costs nothing).
        const fromText = extractIdentifiersFromText(row.messageText ?? '')
        const candidate = {
          name: cand.name,
          email: cand.email ?? fromText.email,
          phone: cand.phone ?? fromText.phone,
        }
        if (!candidate.name && !candidate.email && !candidate.phone) continue

        const match = await matchContactByCandidate(db, candidate)
        if (!match.contactId) continue
        const contactId = match.contactId

        // Idempotent: a row may have been linked by a concurrent pass, or a
        // prior tick that failed after the interaction write. Dedupe on the
        // Slack ts already archived in a slack_summary payload.
        const existing = await db.interaction.findFirst({
          where: { type: 'slack_summary', payload: { path: ['slackTs'], equals: row.slackTs } },
          select: { id: true },
        })
        let interactionId = existing?.id ?? null
        if (!interactionId) {
          const created = await db.interaction.create({
            data: {
              id: createId(),
              type: 'slack_summary',
              contactId,
              occurredAt: row.createdAt,
              summary: (cand.summary ?? row.messageText ?? 'Slack message').slice(0, 280),
              payload: {
                event: 'slack.message_summarised',
                slackTs: row.slackTs,
                channelId: row.channelId,
                permalink: buildSlackPermalink(row.channelId, row.slackTs, null),
                messageText: row.messageText,
                senderName: row.senderName,
                category: cand.category ?? 'general',
                sentiment: cand.sentiment ?? 'neutral',
                suggestedNextAction: cand.suggestedNextAction,
                confidence: row.confidence,
                matchedVia: match.via,
                autoRelinked: true,
                promptVersion: cand.promptVersion ?? 'relink-v1',
              },
            },
            select: { id: true },
          })
          interactionId = created.id
          await writeAuditLogEntry(db, {
            actorId: 'system:slack/relink-unassigned',
            action: 'slack.message_summarised',
            target: { type: 'Contact', id: contactId },
            requestId: `slack-relink:${row.id}`,
            after: { interactionId, matchedVia: match.via, autoRelinked: true },
          })
        }

        await db.unassignedSummary.update({
          where: { id: row.id },
          data: { resolvedAt: new Date() },
        })
        linked += 1
      }

      return { scanned: rows.length, linked }
    })

    logger.info(result, 'slack relink-unassigned complete')
    return result
  },
)
