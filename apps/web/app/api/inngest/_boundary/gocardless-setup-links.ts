// Worker boundary for Direct Debit setup-link automation (ADR 0038
// amendment). Hourly housekeeping with two jobs:
//
//   1. Expire links past their 14-day window (the open route also flips
//      lazily; this keeps the workspace list honest without anyone opening).
//   2. Send ONE automated reminder per link, 3 days after the initial email,
//      to anyone who still hasn't completed their mandate. One nudge, never
//      a nagging sequence (CLAUDE.md §4) — after that it's a human decision.
//
// Lives at the boundary because it sends email (Gmail system mailbox) —
// the lifecycle decisions are pure core functions (CLAUDE.md §5).

import {
  expireStaleSetupLinks,
  listSetupLinkReminderCandidates,
} from '@studymind/core/finance'
import { writeAuditLogEntry } from '@studymind/audit'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'
import { sendSetupLinkEmail } from '@/lib/gocardless/setup-link-email'

export const gocardlessSetupLinkMaintenance = inngest.createFunction(
  {
    id: 'gocardless/setup-link-maintenance',
    name: 'GoCardless: expire setup links + send automated reminders',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 * * * *' },
  async ({ step, logger }) => {
    const expired = await step.run('expire-stale', async () => {
      return expireStaleSetupLinks(db)
    })

    const candidates = await step.run('list-reminder-candidates', async () => {
      const rows = await listSetupLinkReminderCandidates(db)
      // The email needs the contact's first name + family for the timeline.
      const result: Array<{
        id: string
        token: string
        description: string | null
        emailTo: string
        expiresAt: string
        contactId: string
        familyId: string
        firstName: string | null
      }> = []
      for (const row of rows) {
        const link = await db.mandateSetupLink.findUnique({
          where: { id: row.id },
          select: {
            familyId: true,
            contact: { select: { firstName: true } },
          },
        })
        if (!link) continue
        result.push({
          id: row.id,
          token: row.token,
          description: row.description,
          emailTo: row.emailTo,
          expiresAt: row.expiresAt.toISOString(),
          contactId: row.contactId,
          familyId: link.familyId,
          firstName: link.contact.firstName,
        })
      }
      return result
    })

    let reminded = 0
    for (const candidate of candidates) {
      const sent = await step.run(`remind-${candidate.id}`, async () => {
        const result = await sendSetupLinkEmail({
          kind: 'reminder',
          link: {
            id: candidate.id,
            token: candidate.token,
            description: candidate.description,
            expiresAt: new Date(candidate.expiresAt),
            contactId: candidate.contactId,
            familyId: candidate.familyId,
          },
          to: candidate.emailTo,
          firstName: candidate.firstName,
          actorId: null,
        })
        if (result.status === 'sent') {
          await writeAuditLogEntry(db, {
            actorId: null,
            action: 'gocardless.setup_link.reminder_sent',
            target: { type: 'Contact', id: candidate.contactId },
            requestId: `dd-setup-reminder:${candidate.id}`,
            after: { setupLinkId: candidate.id, to: candidate.emailTo },
          })
          return true
        }
        // Skipped (no system mailbox) — leave reminderSentAt unset so the
        // next run retries once the mailbox is connected. Never throw: one
        // bad address must not block the rest of the queue.
        return false
      })
      if (sent) reminded += 1
    }

    logger.info({ expired, reminded }, 'gocardless setup-link maintenance complete')
    return { expired, reminded }
  },
)
