// Change billing contact dialog. CLAUDE.md §6.1 — switching the billing
// contact mid-term is an explicit family.billing_contact_changed Interaction
// with reason and effective date. Open Stripe subscriptions and GoCardless
// mandates do NOT auto-transfer; the agent is reminded to re-issue manually.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Member {
  contactId: string
  name: string
  kind: string
  isMinor: boolean
}

interface Props {
  familyId: string
  members: Member[]
  currentBillingContactId: string | null
}

export function ChangeBillingContactButton({
  familyId,
  members,
  currentBillingContactId,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [newContactId, setNewContactId] = useState<string>('')
  const [reason, setReason] = useState('')
  const [effective, setEffective] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // CLAUDE.md §41 — billing contact must not be a student (minor or
  // student-role). The candidate list excludes students; the server still
  // enforces (assertBillingContactNotStudent) — defence in depth.
  const candidates = members.filter(
    (m) =>
      m.contactId !== currentBillingContactId &&
      m.kind !== 'student' &&
      !m.isMinor,
  )

  const mutate = trpc.family.setBillingContact.useMutation({
    onSuccess: () => {
      setSuccess(true)
      setError(null)
      router.refresh()
    },
    onError: (e) => setError(e.message),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!newContactId) {
      setError('Pick a new billing contact.')
      return
    }
    if (reason.trim().length < 3) {
      setError('Add a short reason (e.g. parental separation).')
      return
    }
    mutate.mutate({
      familyId,
      newBillingContactId: newContactId,
      reason: reason.trim(),
      ...(effective ? { effectiveDate: new Date(effective) } : {}),
    })
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Change billing contact
      </Button>
    )
  }

  return (
    <div
      role="dialog"
      aria-label="Change billing contact"
      className="rounded-md border border-neutral-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">Change billing contact</h3>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setSuccess(false)
            setError(null)
            setNewContactId('')
            setReason('')
            setEffective('')
          }}
          className="text-xs text-neutral-500 hover:underline"
          aria-label="Close"
        >
          Close
        </button>
      </div>

      {success ? (
        <div className="mt-3 space-y-3 text-sm">
          <p className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-900">
            Billing contact updated. <strong>Finance must manually re-issue</strong>{' '}
            any open Stripe subscription or GoCardless mandate — they do not
            auto-transfer. See{' '}
            <a
              href="/runbooks/billing-contact-change"
              className="underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              docs/runbooks/billing-contact-change.md
            </a>
            .
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-3 space-y-3">
          {candidates.length === 0 ? (
            <p className="text-sm text-neutral-700">
              No eligible candidates on this family — link an adult guardian
              contact first, then return here.
            </p>
          ) : (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-700">New billing contact</span>
              <select
                required
                value={newContactId}
                onChange={(e) => setNewContactId(e.target.value)}
                className="rounded border border-neutral-300 bg-white px-2 py-1"
              >
                <option value="">Choose a contact…</option>
                {candidates.map((m) => (
                  <option key={m.contactId} value={m.contactId}>
                    {m.name || m.contactId} ({m.kind})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-700">Reason</span>
            <input
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. parental separation; grandparent taking over"
              className="rounded border border-neutral-300 bg-white px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-700">Effective date (optional)</span>
            <input
              type="date"
              value={effective}
              onChange={(e) => setEffective(e.target.value)}
              className="rounded border border-neutral-300 bg-white px-2 py-1"
            />
          </label>

          <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            Open Stripe subscriptions and GoCardless mandates do NOT
            auto-transfer. Finance must re-issue manually after this change.
          </p>

          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={mutate.isPending || candidates.length === 0}>
              {mutate.isPending ? 'Saving…' : 'Confirm change'}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
