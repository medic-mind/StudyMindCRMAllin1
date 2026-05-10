// Discrepancy resolution actions on the finance dashboard. CLAUDE.md §6.3 —
// nothing is auto-resolved. Every discrepancy carries a "Resolve with
// rationale" action; payment_unallocated rows additionally get inline
// manual-allocation. Client island.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface AllocationLine {
  bookingId: string
  amountMinor: number
  reason: string
}

interface Props {
  discrepancyId: string
  category: string
  /** Optional Payment id from the discrepancy payload — required to allocate. */
  paymentId?: string
  /** Optional set of candidate Booking ids surfaced by the reconciler. */
  candidateBookingIds?: string[]
}

export function DiscrepancyActions({
  discrepancyId,
  category,
  paymentId,
  candidateBookingIds = [],
}: Props) {
  const router = useRouter()
  const [mode, setMode] = useState<'idle' | 'resolve' | 'allocate'>('idle')
  const [rationale, setRationale] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [lines, setLines] = useState<AllocationLine[]>(
    candidateBookingIds.length > 0
      ? candidateBookingIds.map((bookingId) => ({ bookingId, amountMinor: 0, reason: '' }))
      : [{ bookingId: '', amountMinor: 0, reason: '' }],
  )

  const resolve = trpc.finance.discrepancy.resolve.useMutation({
    onSuccess: () => {
      setMode('idle')
      setRationale('')
      router.refresh()
    },
    onError: (e) => setError(e.message),
  })

  const upsertAlloc = trpc.finance.allocation.upsert.useMutation({
    onSuccess: () => {
      // After allocation, mark the discrepancy resolved with the same rationale.
      resolve.mutate({ id: discrepancyId, rationale: rationale || 'Manually allocated.' })
    },
    onError: (e) => setError(e.message),
  })

  function handleResolve(e: React.FormEvent) {
    e.preventDefault()
    if (rationale.trim().length < 3) {
      setError('Add a short rationale.')
      return
    }
    setError(null)
    resolve.mutate({ id: discrepancyId, rationale: rationale.trim() })
  }

  function handleAllocate(e: React.FormEvent) {
    e.preventDefault()
    if (!paymentId) {
      setError('No paymentId on this discrepancy — resolve manually with a rationale instead.')
      return
    }
    const cleaned = lines.filter((l) => l.bookingId.trim() && l.amountMinor > 0)
    if (cleaned.length === 0) {
      setError('Add at least one allocation line.')
      return
    }
    if (rationale.trim().length < 3) {
      setError('Add a short rationale that the audit row can record.')
      return
    }
    setError(null)
    upsertAlloc.mutate({
      paymentId,
      allocations: cleaned.map((l) => ({
        bookingId: l.bookingId.trim(),
        amountMinor: l.amountMinor,
        reason: l.reason.trim() || rationale.trim(),
      })),
    })
  }

  if (mode === 'idle') {
    return (
      <div className="flex gap-2">
        {category === 'payment_unallocated' && paymentId ? (
          <Button type="button" size="sm" onClick={() => setMode('allocate')}>
            Allocate manually
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setMode('resolve')}
        >
          Resolve with rationale
        </Button>
      </div>
    )
  }

  if (mode === 'resolve') {
    return (
      <form onSubmit={handleResolve} className="mt-2 space-y-2">
        <textarea
          required
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why is this discrepancy ok to close?"
          rows={3}
          className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
        />
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={resolve.isPending}>
            {resolve.isPending ? 'Saving…' : 'Resolve'}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setMode('idle')}>
            Cancel
          </Button>
        </div>
      </form>
    )
  }

  return (
    <form onSubmit={handleAllocate} className="mt-2 space-y-2">
      <p className="text-xs text-neutral-600">
        Distribute Payment <span className="font-mono">{paymentId}</span> across
        bookings. The sum cannot exceed the Payment amount.
      </p>
      {lines.map((line, idx) => (
        <div key={idx} className="grid grid-cols-3 gap-2 text-sm">
          <input
            placeholder="Booking id"
            value={line.bookingId}
            onChange={(e) =>
              setLines((prev) =>
                prev.map((l, i) => (i === idx ? { ...l, bookingId: e.target.value } : l)),
              )
            }
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          />
          <input
            type="number"
            min={1}
            placeholder="Amount (pence)"
            value={line.amountMinor || ''}
            onChange={(e) =>
              setLines((prev) =>
                prev.map((l, i) =>
                  i === idx ? { ...l, amountMinor: Number(e.target.value) || 0 } : l,
                ),
              )
            }
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          />
          <input
            placeholder="Line reason (optional)"
            value={line.reason}
            onChange={(e) =>
              setLines((prev) =>
                prev.map((l, i) => (i === idx ? { ...l, reason: e.target.value } : l)),
              )
            }
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          />
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setLines((p) => [...p, { bookingId: '', amountMinor: 0, reason: '' }])}
      >
        + Add line
      </Button>

      <textarea
        required
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        placeholder="Audit rationale for the override"
        rows={2}
        className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
      />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={upsertAlloc.isPending || resolve.isPending}>
          {upsertAlloc.isPending || resolve.isPending ? 'Saving…' : 'Save & resolve'}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setMode('idle')}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
