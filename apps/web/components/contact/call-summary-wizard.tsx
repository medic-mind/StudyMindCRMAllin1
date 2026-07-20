// The call-summary form — shared by the contact page, the board card modal,
// and the /call-summaries workspace so every surface behaves identically
// (redesign 2026-07).
//
// It is deliberately simple: a staff member types what happened on the call,
// picks an optional outcome, and submits. The summary is RECORDED on the
// customer's CRM record (a `call_summary` Interaction on their timeline) and
// ANNOUNCED to the `#callsummaries` Slack channel. No customer message is ever
// sent from the CRM — no email, no WhatsApp/SMS, no templates, no attachments.
// CLAUDE.md §12, §26.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

type Outcome = 'answered' | 'voicemail' | 'no_answer'

const OUTCOMES: Array<{ key: Outcome; label: string }> = [
  { key: 'answered', label: 'Answered' },
  { key: 'voicemail', label: 'Voicemail' },
  { key: 'no_answer', label: 'No answer' },
]

export interface CallSummaryWizardProps {
  /** Which tRPC namespace records the summary. */
  mode: 'contact' | 'card'
  contactId: string
  /** Required in card mode. */
  cardId?: string
  contactName: string
}

/** Turn the best-effort Slack result into a plain-English toast line. */
function slackNote(status: string | undefined): string {
  if (status === 'sent') return 'posted to #callsummaries'
  if (status === 'skipped') return 'Slack not configured — set it up in Settings → Slack channels'
  return "couldn't post to Slack (recorded on the CRM)"
}

export function CallSummaryWizard({ mode, contactId, cardId, contactName }: CallSummaryWizardProps) {
  const router = useRouter()
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [body, setBody] = useState('')

  const contactAdd = trpc.contact.callSummary.add.useMutation()
  const cardAdd = trpc.card.callSummary.add.useMutation()
  const pending = contactAdd.isPending || cardAdd.isPending

  async function submit() {
    const text = body.trim()
    if (text.length === 0) {
      toast.error('Type the call summary first.')
      return
    }
    try {
      const result =
        mode === 'card' && cardId
          ? await cardAdd.mutateAsync({ cardId, body: text, outcome: outcome ?? undefined })
          : await contactAdd.mutateAsync({ contactId, body: text, outcome: outcome ?? undefined })

      const status = result.slack?.status
      if (status === 'sent') {
        toast.success('Call summary recorded and posted to #callsummaries')
      } else {
        toast.success(`Call summary recorded — ${slackNote(status)}`)
      }
      setBody('')
      setOutcome(null)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the call summary')
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <span className="mb-1.5 block text-xs font-medium text-neutral-600">How did the call go?</span>
        <div className="inline-flex flex-wrap items-center gap-1.5">
          {OUTCOMES.map((o) => {
            const active = outcome === o.key
            return (
              <button
                key={o.key}
                type="button"
                aria-pressed={active}
                onClick={() => setOutcome(active ? null : o.key)}
                className={
                  active
                    ? 'rounded-full bg-primary-600 px-3 py-1 text-xs font-medium text-white'
                    : 'rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50'
                }
              >
                {o.label}
              </button>
            )
          })}
        </div>
      </div>

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        placeholder={`What did you discuss with ${contactName}? This is recorded on their record and posted to #callsummaries.`}
        aria-label="Call summary"
      />

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">
          Recorded on the CRM and posted to Slack. No message is sent to the customer.
        </p>
        <Button type="button" onClick={submit} disabled={pending || body.trim().length === 0}>
          {pending ? 'Recording…' : 'Record & post to Slack'}
        </Button>
      </div>
    </div>
  )
}
