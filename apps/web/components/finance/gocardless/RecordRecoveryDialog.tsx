'use client'

// Record how a Direct Debit shortfall was recovered (ADR 0038, seventh
// amendment, Phase 2). An agent confirms money arrived via the invoicing site
// (bank transfer), Stripe, a re-collected Direct Debit, or manually, with an
// optional reference. Records only — never charges (CLAUDE.md §3).

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { trpc } from '@/lib/trpc/client'

const METHODS: Array<{ value: string; label: string }> = [
  { value: 'bank_transfer', label: 'Bank transfer (invoicing site)' },
  { value: 'stripe', label: 'Stripe payment' },
  { value: 'direct_debit', label: 'Re-collected Direct Debit' },
  { value: 'manual', label: 'Manual / other record' },
  { value: 'other', label: 'Other' },
]

export interface RecoveryLinks {
  gcSubscriptionId: string
  gcCustomerId: string | null
  contactId: string | null
  familyId: string | null
  openingShortfallMinor: number
}

export function RecordRecoveryDialog({
  links,
  defaultAmountMinor,
  onDone,
}: {
  links: RecoveryLinks
  defaultAmountMinor: number
  onDone?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [method, setMethod] = useState('bank_transfer')
  const [pounds, setPounds] = useState((defaultAmountMinor / 100).toFixed(2))
  const [ref, setRef] = useState('')

  const utils = trpc.useUtils()
  const mutation = trpc.finance.directDebit.cases.recordRecovery.useMutation({
    onSuccess: async () => {
      await utils.finance.directDebit.cases.forSubscriptions.invalidate()
      toast.success('Recovery recorded')
      setOpen(false)
      onDone?.()
    },
    onError: (e) => toast.error(e.message),
  })

  function submit() {
    const recoveredMinor = Math.round(Number.parseFloat(pounds) * 100)
    if (!Number.isFinite(recoveredMinor) || recoveredMinor < 0) {
      toast.error('Enter a valid amount')
      return
    }
    mutation.mutate({
      gcSubscriptionId: links.gcSubscriptionId,
      recoveredMinor,
      method,
      ref: ref.trim() || null,
      links: {
        gcCustomerId: links.gcCustomerId,
        contactId: links.contactId,
        familyId: links.familyId,
        openingShortfallMinor: links.openingShortfallMinor,
      },
    })
  }

  return (
    <>
      <Button type="button" size="xs" variant="secondary" onClick={() => setOpen(true)}>
        Record recovery
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Record recovery"
        dismissable={!mutation.isPending}
      >
        <div className="space-y-3">
          <p className="text-sm text-neutral-600">
            Record that this shortfall was repaid elsewhere. This closes the case as recovered
            — it does not collect any money.
          </p>
          <Field label="How was it recovered?" htmlFor="recovery-method">
            <select
              id="recovery-method"
              className="h-9 w-full rounded-md border border-neutral-200 bg-white px-2 text-sm"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount recovered (£)" htmlFor="recovery-amount">
            <Input
              id="recovery-amount"
              inputMode="decimal"
              value={pounds}
              onChange={(e) => setPounds(e.target.value)}
            />
          </Field>
          <Field
            label="Reference (optional)"
            htmlFor="recovery-ref"
            hint="Invoice id (b2b.studymind.co.uk), Stripe payment id, or a note."
          >
            <Input
              id="recovery-ref"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="INV-1234 / pi_… / cheque"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Record recovery'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
