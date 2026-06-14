'use client'

// Send a human-confirmed recovery email from a Direct Debit case (ADR 0038,
// Phase 3b). The agent picks a staff-authored template, the tokens are filled
// from the case, then they review/edit the subject + body and send. The send
// goes through the system mailbox and logs onto the customer's timeline.
// Nothing sends without the agent clicking Send (CLAUDE.md §3).

import { useState } from 'react'
import { toast } from 'sonner'

// Import the pure template helper directly (NOT the finance barrel): the barrel
// re-exports reconcile.ts which imports node:crypto, which webpack cannot bundle
// into this client component (breaks `next build`).
import { renderRecoveryTemplate, type RecoveryTemplateVars } from '@studymind/core/finance/dd-comms'

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
  const [templateId, setTemplateId] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  const templates = trpc.ddRecoveryTemplate.pickList.useQuery(
    { channel: 'email' },
    { enabled: open },
  )
  const utils = trpc.useUtils()
  const send = trpc.finance.directDebit.cases.sendRecovery.useMutation({
    onSuccess: async () => {
      await utils.finance.directDebit.cases.forSubscriptions.invalidate()
      toast.success('Recovery email sent')
      setOpen(false)
    },
    onError: (e) => toast.error(e.message),
  })

  const vars = buildVars(context)
  const noContact = !context.contactId

  function applyTemplate(id: string) {
    setTemplateId(id)
    const t = templates.data?.find((x) => x.id === id)
    if (!t) return
    setSubject(renderRecoveryTemplate(t.subject ?? '', vars))
    setBody(renderRecoveryTemplate(t.body, vars))
  }

  function submit() {
    if (!context.contactId) return
    if (!subject.trim() || !body.trim()) {
      toast.error('Subject and body are required')
      return
    }
    send.mutate({
      gcSubscriptionId: context.gcSubscriptionId,
      contactId: context.contactId,
      templateId: templateId || null,
      subject,
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
        Send email
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Send recovery email"
        dismissable={!send.isPending}
      >
        <div className="space-y-3">
          {noContact ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              This plan isn&apos;t linked to a CRM contact yet, so there&apos;s no one to email.
              Link the GoCardless customer first.
            </p>
          ) : (
            <>
              <p className="text-xs text-neutral-500">
                Review and edit before sending — this goes to the customer from the system
                mailbox and is logged on their timeline.
              </p>
              <Field label="Template" htmlFor="recovery-template">
                <select
                  id="recovery-template"
                  className="h-9 w-full rounded-md border border-neutral-200 bg-white px-2 text-sm"
                  value={templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                >
                  <option value="">Choose a template…</option>
                  {(templates.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.kind === 'legal_escalation' ? '⚖ ' : ''}
                      {t.name}
                    </option>
                  ))}
                </select>
                {templates.data && templates.data.length === 0 ? (
                  <span className="text-xs text-neutral-500">
                    No email templates yet — add them in Settings → Direct Debit recovery
                    templates.
                  </span>
                ) : null}
              </Field>
              <Field label="Subject" htmlFor="recovery-subject">
                <Input
                  id="recovery-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>
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
            <Button
              type="button"
              size="sm"
              onClick={submit}
              disabled={send.isPending || noContact}
            >
              {send.isPending ? 'Sending…' : 'Send email'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
