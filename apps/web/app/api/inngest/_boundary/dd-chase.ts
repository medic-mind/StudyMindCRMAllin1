// Hourly automated Direct Debit chase engine (ADR 0045). CLAUDE.md §9, §17.
//
// For every open recovery case the operator has armed (auto-chase on, a
// staff-pasted re-signup link, at least one channel enabled) this:
//   1. AUTO-RESOLVES the case when the GoCardless mirror shows a fresh ACTIVE
//      mandate created after the case opened — the person set their Direct
//      Debit back up, so messages stop without anyone ticking a box.
//   2. Sends the due chase message on each enabled channel, walking the
//      staff-authored template sequence so the copy gets more serious each
//      step; when the sequence is exhausted the case flags for a human
//      instead of nagging forever.
//
// Email goes via the system Gmail mailbox; SMS starts a Trengo conversation
// under the case owner's (else creator's) agent token — per-agent tokens are
// the Trengo rule (§11), there is no shared service token. Every send is
// logged (DdCaseMessage + a contact timeline note + audit); failures are
// recorded, never silently dropped.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import {
  chaseAutoResolved,
  decideChaseTick,
  nextChaseAt,
  renderRecoveryTemplate,
  renderRecoveryLetterPdf,
  type ChaseTemplateRef,
} from '@studymind/core/finance'
import { inngest } from '@studymind/jobs'
import { sendSystemEmail } from '@studymind/integration-gmail/system-send'
import { outbound as trengoOutbound } from '@studymind/integration-trengo'

import { db } from '@/lib/db'
import { buildCaseRecoveryVars } from '@/lib/finance/recovery-vars'
import { companyLetterhead, loadDdRecoverySettings } from '@/lib/finance/recovery-settings'

/** Cases examined per tick — a huge backlog drains over a few ticks. */
const CHASE_BATCH = 100

const OPEN_STATUSES = ['new', 'chasing', 'escalated'] as const

export const ddChaseTick = inngest.createFunction(
  {
    id: 'finance/dd-chase-tick',
    name: 'Direct Debit: automated chase engine',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '0 * * * *' },
  async ({ logger }) => {
    const now = new Date()

    // Plain awaits, not step.run: step results are JSON-serialised, which
    // turns the Date columns the engine compares on into strings. The whole
    // tick is idempotent per send (requestId per case+step) so a retry of the
    // run is safe without step granularity.
    const cases = await db.directDebitCase.findMany({
      where: { deletedAt: null, status: { in: [...OPEN_STATUSES] }, autoChase: true },
      orderBy: { createdAt: 'asc' },
      take: CHASE_BATCH,
    })
    if (cases.length === 0) return { examined: 0, resolved: 0, sent: 0, exhausted: 0 }

    const templates = await db.ddRecoveryTemplate.findMany({
      where: { deletedAt: null, archivedAt: null, body: { not: '' } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        channel: true,
        kind: true,
        subject: true,
        body: true,
        pdfFileName: true,
        pdfContentType: true,
        pdfData: true,
      },
    })
    // Legal-escalation email templates (stern / CCJ) go out with a PDF copy of
    // the letter generated from the personalised body; gentle reminders don't.
    const legalTemplateIds = new Set(
      templates.filter((t) => t.kind === 'legal_escalation').map((t) => t.id),
    )
    const emailTemplates: ChaseTemplateRef[] = templates
      .filter((t) => t.channel === 'email')
      .map((t) => ({ id: t.id, channel: 'email', subject: t.subject, body: t.body }))
    const smsTemplates: ChaseTemplateRef[] = templates
      .filter((t) => t.channel === 'sms')
      .map((t) => ({ id: t.id, channel: 'sms', subject: null, body: t.body }))
    // The escalation "letter" PDF the team already sends, attached to each
    // email step (ADR 0045 amendment). Keyed by template id so the chosen step
    // carries its own document.
    const pdfByTemplateId = new Map<string, { filename: string; content: Buffer; contentType?: string }>()
    for (const t of templates) {
      if (t.pdfData) {
        pdfByTemplateId.set(t.id, {
          filename: t.pdfFileName ?? 'document.pdf',
          content: Buffer.from(t.pdfData),
          contentType: t.pdfContentType ?? 'application/pdf',
        })
      }
    }

    // Customisable recovery settings (late fee, response window, phone,
    // letterhead) — loaded once per tick.
    const settings = await loadDdRecoverySettings(db)
    const letterhead = companyLetterhead(settings)

    let resolved = 0
    let sent = 0
    let exhausted = 0

    for (const c of cases) {
      // 1. Auto-resolve from the mirror: a fresh active mandate after the case
      // opened = they signed back up. Messages stop with no human tick.
      if (c.gcCustomerId) {
        const mandateRows = await db.gcMandate.findMany({
          where: { gcCustomerId: c.gcCustomerId, deletedAt: null },
          select: { state: true, createdAt: true, gcCreatedAt: true, gcMandateId: true },
        })
        // Provider creation time preferred — the mirror row's createdAt is
        // when WE imported it, which a historic backfill would set to today.
        const mandates = mandateRows.map((m) => ({
          status: m.state as string,
          createdAt: m.gcCreatedAt ?? m.createdAt,
          gcMandateId: m.gcMandateId,
        }))
        if (chaseAutoResolved(c.createdAt, mandates)) {
          const mandate = mandates.find((m) => m.status === 'active')
          await db.directDebitCase.update({
            where: { id: c.id },
            data: {
              status: 'recovered',
              recoveredAt: now,
              recoveryMethod: 'direct_debit',
              recoveryRef: mandate?.gcMandateId ?? null,
              nextAutoMessageAt: null,
              updatedById: null,
            },
          })
          if (c.contactId) {
            await db.interaction.create({
              data: {
                id: createId(),
                type: 'note',
                contactId: c.contactId,
                occurredAt: now,
                summary: 'Direct Debit set back up — automated chasing stopped',
                payload: {
                  event: 'direct_debit.case_auto_resolved',
                  caseId: c.id,
                  gcMandateId: mandate?.gcMandateId ?? null,
                },
              },
            })
          }
          await writeAuditLogEntry(db, {
            actorId: null,
            action: 'direct_debit.case_auto_resolved',
            target: { type: 'DirectDebitCase', id: c.id },
            requestId: `dd-chase:${c.id}:${now.toISOString().slice(0, 13)}`,
            after: { gcMandateId: mandate?.gcMandateId ?? null },
          })
          resolved += 1
          continue
        }
      }

      // 2. Send whatever is due.
      const decision = decideChaseTick({
        cs: {
          status: c.status as 'new' | 'chasing' | 'escalated',
          autoChase: c.autoChase,
          sendEmails: c.sendEmails,
          sendTexts: c.sendTexts,
          chaseEmail: c.chaseEmail,
          chasePhoneE164: c.chasePhoneE164,
          setupLinkUrl: c.setupLinkUrl,
          escalationStep: c.escalationStep,
          nextAutoMessageAt: c.nextAutoMessageAt,
        },
        now,
        emailTemplates,
        smsTemplates,
      })

      if (decision.kind === 'exhausted') {
        // Sequence fully sent — stop and put it in front of a human.
        await db.directDebitCase.update({
          where: { id: c.id },
          data: {
            autoChase: false,
            nextAutoMessageAt: null,
            ...(c.status !== 'escalated' ? { status: 'escalated' } : {}),
          },
        })
        await writeAuditLogEntry(db, {
          actorId: null,
          action: 'direct_debit.case_chase_exhausted',
          target: { type: 'DirectDebitCase', id: c.id },
          requestId: `dd-chase:${c.id}:exhausted`,
          after: { escalationStep: c.escalationStep },
        })
        exhausted += 1
        continue
      }
      if (decision.kind === 'skip') continue

      const contact = c.contactId
        ? await db.contact.findUnique({
            where: { id: c.contactId },
            select: { firstName: true, lastName: true },
          })
        : null
      // Full token set incl. the calculated CCJ court fee + statutory interest.
      // Only the stern / CCJ templates reference those, so the gentle reminders
      // stay gentle. Name: the linked contact wins, else the standalone case's
      // own name (ADR 0045 amendment — most chased people predate the CRM).
      const { vars } = buildCaseRecoveryVars(
        {
          personName: c.personName,
          contactFirstName: contact?.firstName ?? null,
          contactLastName: contact?.lastName ?? null,
          outstandingMinor: Math.max(0, c.openingShortfallMinor - c.recoveredMinor),
          setupLinkUrl: c.setupLinkUrl,
          createdAt: c.createdAt,
        },
        now,
        settings,
      )

      const sentChannels: string[] = []
      for (const s of decision.sends) {
        // Idempotency (§2): a whole-tick retry (Inngest re-runs the function on
        // failure) must not re-send a channel already sent at this step. The
        // DdCaseMessage row is the durable per-send record — neither
        // sendSystemEmail nor the standalone SMS path dedupes on requestId.
        const already = await db.ddCaseMessage.findFirst({
          where: { caseId: c.id, step: c.escalationStep, channel: s.channel, status: 'sent' },
          select: { id: true },
        })
        if (already) {
          sentChannels.push(s.channel)
          continue
        }
        const subject = s.template.subject
          ? renderRecoveryTemplate(s.template.subject, vars)
          : 'Your Direct Debit needs setting back up'
        const body = renderRecoveryTemplate(s.template.body, vars)
        let status: 'sent' | 'failed' = 'sent'
        let error: string | null = null
        try {
          if (s.channel === 'email') {
            const attachments: Array<{ filename: string; content: Buffer; contentType?: string }> = []
            // A PDF copy of the letter itself for the serious steps.
            if (legalTemplateIds.has(s.template.id)) {
              attachments.push({
                filename: 'letter.pdf',
                content: renderRecoveryLetterPdf({ subject, body, ...letterhead }),
                contentType: 'application/pdf',
              })
            }
            // Any fixed document staff attached to the template (e.g. the
            // Pre-Action Protocol information sheet / reply form).
            const staticPdf = pdfByTemplateId.get(s.template.id)
            if (staticPdf) attachments.push(staticPdf)
            const r = await sendSystemEmail({
              to: s.to,
              subject,
              text: body,
              requestId: `dd-chase:${c.id}:${c.escalationStep}:email`,
              ...(attachments.length > 0 ? { attachments } : {}),
            })
            if (r.status !== 'sent') {
              status = 'failed'
              error = `system email ${r.status}`
            }
          } else {
            const agentId = c.ownerUserId ?? c.createdById
            if (!agentId) throw new Error('no case owner for the Trengo SMS token')
            // Linked contact → reflect on their timeline; standalone person →
            // raw send (the DdCaseMessage row below is the record).
            if (c.contactId) {
              await trengoOutbound.startConversation({
                contactId: c.contactId,
                agentId,
                channel: 'sms',
                recipient: s.to,
                body,
                requestId: `dd-chase:${c.id}:${c.escalationStep}:sms`,
              })
            } else {
              await trengoOutbound.sendStandaloneMessage({
                agentId,
                channel: 'sms',
                recipient: s.to,
                body,
                requestId: `dd-chase:${c.id}:${c.escalationStep}:sms`,
                auditTarget: { type: 'DirectDebitCase', id: c.id },
              })
            }
          }
        } catch (err) {
          status = 'failed'
          error = err instanceof Error ? err.message : 'unknown error'
        }
        await db.ddCaseMessage.create({
          data: {
            id: createId(),
            caseId: c.id,
            channel: s.channel,
            templateId: s.template.id,
            step: c.escalationStep,
            toAddress: s.to,
            subject: s.channel === 'email' ? subject : null,
            body,
            status,
            error,
          },
        })
        if (status === 'sent') sentChannels.push(s.channel)
        else logger.warn({ caseId: c.id, channel: s.channel, error }, 'dd-chase send failed')
      }

      if (sentChannels.length > 0) {
        await db.directDebitCase.update({
          where: { id: c.id },
          data: {
            escalationStep: c.escalationStep + 1,
            lastAutoMessageAt: now,
            nextAutoMessageAt: nextChaseAt(now, c.cadenceDays),
            ...(c.status === 'new' ? { status: 'chasing' } : {}),
          },
        })
        if (c.contactId) {
          await db.interaction.create({
            data: {
              id: createId(),
              type: 'note',
              contactId: c.contactId,
              occurredAt: now,
              summary: `Direct Debit chase sent (step ${c.escalationStep + 1}) — ${sentChannels.join(' + ')}`,
              payload: {
                event: 'direct_debit.case_message_sent',
                caseId: c.id,
                step: c.escalationStep,
                channels: sentChannels,
              },
            },
          })
        }
        await writeAuditLogEntry(db, {
          actorId: null,
          action: 'direct_debit.case_message_sent',
          target: { type: 'DirectDebitCase', id: c.id },
          requestId: `dd-chase:${c.id}:${c.escalationStep}`,
          after: { step: c.escalationStep, channels: sentChannels },
        })
        sent += 1
      } else if (decision.sends.length > 0) {
        // Every channel failed — try again next tick rather than escalating.
        await db.directDebitCase.update({
          where: { id: c.id },
          data: { nextAutoMessageAt: nextChaseAt(now, 1) },
        })
      }
    }

    logger.info({ examined: cases.length, resolved, sent, exhausted }, 'dd-chase tick complete')
    return { examined: cases.length, resolved, sent, exhausted }
  },
)
