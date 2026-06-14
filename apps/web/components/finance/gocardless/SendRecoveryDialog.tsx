'use client'

// Send a human-confirmed recovery message from a Direct Debit case (ADR 0038,
// Phase 3b/3c). The agent picks a staff-authored template, the tokens are
// filled from the case, then they review/edit and send by email or SMS. Email
// goes via the system mailbox and logs an email_sent Interaction; SMS goes via
// Trengo (continuing the contact's thread, else starting one). Nothing sends
// without the agent clicking Send (CLAUDE.md §3).

import { useState } from 'react'
import { toast } from 'sonner'

import { renderRecoveryTemplate, type RecoveryTemplateVars } from '@studymind/core/finance'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

export interface SendRecoveryContext {
  gcSubscriptionId: string
  contactId: string | null
  gcCustomerId: string | null
  familyId: string | null
  customerName: string | null
  planName: string | null
  currency: string
  shortfallMinor: number
  collectedMinor: number
  expectedTotalMinor: number
}

type Channel = 'email' | 'sms'

function buildVars(ctx: SendRecoveryContext): RecoveryTemplateVars {
  const full = ctx.customerName ?? ''
  const first = full.split(/\s+/u)[0] ?? ''
  const last = full.split(/\s+/u).slice(1).join(' ')
  return {
    first_name: first,
    last_name: last,
    full_name: full,
    customer_name: full,
    plan_name: ctx.planName ?? '',
    amount_due: formatMoneyMinor(ctx.shortfallMinor, ctx.currency),
    collected: formatMoneyMinor(ctx.collectedMinor, ctx.currency),
    plan_total: formatMoneyMinor(ctx.expectedTotalMinor, ctx.currency),
  }
}

export function SendRecoveryDialog({ context }: { context: SendRecoveryContext }) {
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState<Channel>('email')
  const [templateId, setTemplateId] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  // All active templates; filtered to the chosen channel below (SMS also offers
  // the generic Trengo-channel templates).
  const templates = trpc.ddRecoveryTemplate.pickList.useQuery(undefined, { enabled: open })
  const utils = trpc.useUtils()
  const send = trpc.finance.directDebit.cases.sendRecovery.useMutation({
    onSuccess: async () => {
      await utils.finance.directDebit.cases.forSubscriptions.invalidate()
      await utils.gocardless.contactSummary.invalidate()
      toast.success(channel === 'email' ? 'Recovery email sent' : 'Recovery SMS sent')
      setOpen(false)
    },
    onError: (e) => toast.error(e.message),
  })

  const vars = buildVars(context)
  const noContact = !context.contactId

  const visibleTemplates = (templates.data ?? []).filter((t) =>
    channel === 'email' ? t.channel === 'email' : t.channel === 'sms' || t.channel === 'trengo',
  )

  function selectChannel(next: Channel) {
    setChannel(next)
    setTemplateId('')
    setSubject('')
    setBody('')
  }

  function applyTemplate(id: string) {
    setTemplateId(id)
    const t = visibleTemplates.find((x) => x.id === id)
    if (!t) return
    if (channel === 'email') setSubject(renderRecoveryTemplate(t.subject ?? '', vars))
    setBody(renderRecoveryTemplate(t.body, vars))
  }

  function submit() {
    if (!context.contactId) return
    if (channel === 'email' && !subject.trim()) {
      toast.error('Subject is required')
      return
    }
    if (!body.trim()) {
      toast.error('Message is required')
      return
    }
    send.mutate({
      gcSubscriptionId: context.gcSubscriptionId,
      contactId: context.contactId,
      channel,
      templateId: templateId || null,
      subject: channel === 'email' ? subject : undefined,
      body,
      links: {
        gcCustomerId: context.gcCustomerId,
        familyId: context.familyId,
        openingShortfallMinor: context.shortfallMinor,
      },
    })
  }

  return (
    <>
      <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Send message
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Send recovery message"
        dismissable={!send.isPending}
      >
        <div className="space-y-3">
          {noContact ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              This plan isn&apos;t linked to a CRM contact yet, so there&apos;s no one to message.
              Link the GoCardless customer first.
            </p>
          ) : (
            <>
              <div className="inline-flex rounded-md border border-neutral-200 p-0.5 text-sm">
                {(['email', 'sms'] as Channel[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`rounded px-3 py-1 ${
                      channel === c ? 'bg-neutral-900 text-white' : 'text-neutral-600'
                    }`}
                    onClick={() => selectChannel(c)}
                  >
                    {c === 'email' ? 'Email' : 'SMS'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-neutral-500">
                Review and edit before sending — this goes to the customer and is logged on their
                timeline.
              </p>
              <Field label="Template" htmlFor="recovery-template">
                <select
                  id="recovery-template"
                  className="h-9 w-full rounded-md border border-neutral-200 bg-white px-2 text-sm"
                  value={templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                >
                  <option value="">Choose a template…</option>
                  {visibleTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.kind === 'legal_escalation' ? '⚖ ' : ''}
                      {t.name}
                    </option>
                  ))}
                </select>
                {templates.data && visibleTemplates.length === 0 ? (
                  <span className="text-xs text-neutral-500">
                    No {channel === 'email' ? 'email' : 'SMS'} templates yet — add them in Settings
                    → Direct Debit recovery templates.
                  </span>
                ) : null}
              </Field>
              {channel === 'email' ? (
                <Field label="Subject" htmlFor="recovery-subject">
                  <Input
                    id="recovery-subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                </Field>
              ) : null}
              <Field label="Message" htmlFor="recovery-body">
                <textarea
                  id="recovery-body"
                  className="min-h-[200px] w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </Field>
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={send.isPending}
            >
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={send.isPending || noContact}>
              {send.isPending ? 'Sending…' : channel === 'email' ? 'Send email' : 'Send SMS'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
