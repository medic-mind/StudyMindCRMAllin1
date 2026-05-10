// Send payment link dialog. CLAUDE.md §8 (Payment Links are the preferred way
// for agents to send a one-off charge from inside the CRM), §3 (no silent
// data mutation — agent confirms; AI never auto-charges). Client island.

'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Props {
  familyId: string
  /** Optional: when launched from a Contact detail page, pre-bind the contact. */
  contactId?: string
}

function poundsToMinor(value: string): number | null {
  // Accept "12", "12.50", "12.5" — UK English, two decimal places maximum.
  const trimmed = value.trim()
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(trimmed)) return null
  const [pounds, pence = ''] = trimmed.split('.')
  const minor = Number(pounds) * 100 + Number(pence.padEnd(2, '0').slice(0, 2))
  return Number.isFinite(minor) && minor > 0 ? minor : null
}

export function SendPaymentLinkButton({ familyId, contactId }: Props) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [productName, setProductName] = useState('One-off session')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ url: string; id: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const create = trpc.finance.paymentLink.create.useMutation({
    onSuccess: (out) => {
      setResult({ url: out.url, id: out.paymentLinkIntentId })
      setError(null)
    },
    onError: (e) => setError(e.message),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const minor = poundsToMinor(amount)
    if (minor === null) {
      setError('Enter a positive amount in pounds, e.g. 50 or 12.50')
      return
    }
    if (reason.trim().length < 2) {
      setError('Add a short reason (e.g. trial session, top-up).')
      return
    }
    create.mutate({
      familyId,
      contactId: contactId,
      amountMinor: minor,
      reason: reason.trim(),
      productName: productName.trim() || 'One-off session',
    })
  }

  async function handleCopy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be blocked; the URL is still visible inline.
    }
  }

  function handleClose() {
    setOpen(false)
    setAmount('')
    setReason('')
    setProductName('One-off session')
    setError(null)
    setResult(null)
    setCopied(false)
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Send payment link
      </Button>
    )
  }

  return (
    <div
      role="dialog"
      aria-label="Send payment link"
      className="rounded-md border border-neutral-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">Send payment link</h3>
        <button
          type="button"
          onClick={handleClose}
          className="text-xs text-neutral-500 hover:underline"
          aria-label="Close"
        >
          Close
        </button>
      </div>

      {result ? (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-neutral-700">
            Payment link created. Share with the family — Stripe will email a
            receipt on completion.
          </p>
          <div className="break-all rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-xs">
            {result.url}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={handleClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-3 space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-700">Amount (£)</span>
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 50 or 12.50"
              className="rounded border border-neutral-300 bg-white px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-700">Product name (visible to the family)</span>
            <input
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              className="rounded border border-neutral-300 bg-white px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-700">Internal reason</span>
            <input
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. trial_session, topup_5h"
              className="rounded border border-neutral-300 bg-white px-2 py-1"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create link'}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
