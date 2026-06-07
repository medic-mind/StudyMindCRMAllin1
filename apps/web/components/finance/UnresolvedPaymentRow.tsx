// One unresolved Stripe payment row. Client island: a person links the charge
// to a Family (records the Payment + creates the StripeCustomer mapping so
// future charges auto-resolve) or dismisses it with a reason. CLAUDE.md §3 —
// nothing auto-creates a Family; every action requires a human to confirm.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Td, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

interface UnresolvedPayment {
  id: string
  stripeChargeId: string
  stripeCustomerId: string
  amountMinor: number
  currency: string
  receivedAt: Date
  customerEmail: string | null
  customerName: string | null
  description: string | null
  productHandles: string[]
}

export function UnresolvedPaymentRow({ payment }: { payment: UnresolvedPayment }) {
  const router = useRouter()
  const [mode, setMode] = useState<'idle' | 'link' | 'dismiss'>('idle')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const search = trpc.family.search.useQuery(
    { q: query },
    { enabled: mode === 'link' && query.trim().length >= 2 },
  )

  const resolve = trpc.finance.unresolvedPayments.resolve.useMutation({
    onSuccess: () => {
      toast.success('Payment linked to family')
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not link payment')
    },
  })

  const dismiss = trpc.finance.unresolvedPayments.dismiss.useMutation({
    onSuccess: () => {
      toast.success('Payment dismissed')
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not dismiss payment')
    },
  })

  function handleLink(e: React.FormEvent) {
    e.preventDefault()
    if (!picked) {
      setError('Pick a family to link this payment to.')
      return
    }
    setError(null)
    resolve.mutate({ id: payment.id, familyId: picked.id })
  }

  function handleDismiss(e: React.FormEvent) {
    e.preventDefault()
    if (reason.trim().length < 3) {
      setError('Add a short reason (audited).')
      return
    }
    setError(null)
    dismiss.mutate({ id: payment.id, reason: reason.trim() })
  }

  return (
    <Tr>
      <Td className="whitespace-nowrap text-sm text-neutral-600">
        {new Date(payment.receivedAt).toLocaleDateString('en-GB')}
      </Td>
      <Td className="text-sm">
        <div className="font-medium text-neutral-900">{payment.customerName ?? '—'}</div>
        <div className="text-neutral-500">{payment.customerEmail ?? 'no email on charge'}</div>
        <div className="font-mono text-xs text-neutral-400">{payment.stripeCustomerId}</div>
      </Td>
      <Td className="whitespace-nowrap text-right font-mono text-sm tabular-nums">
        {formatMoneyMinor(payment.amountMinor, payment.currency)}
      </Td>
      <Td className="text-sm">
        {payment.productHandles.length > 0 ? (
          <span className="text-neutral-700">{payment.productHandles.join(', ')}</span>
        ) : (
          <span className="text-neutral-400">{payment.description ?? 'unclassified'}</span>
        )}
      </Td>
      <Td className="align-top">
        {mode === 'idle' && (
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => setMode('link')}>
              Link to family
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setMode('dismiss')}
            >
              Dismiss
            </Button>
          </div>
        )}

        {mode === 'link' && (
          <form onSubmit={handleLink} className="space-y-2">
            <input
              autoFocus
              value={picked ? picked.label : query}
              onChange={(e) => {
                setPicked(null)
                setQuery(e.target.value)
              }}
              placeholder="Search family or billing contact…"
              className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm sm:w-64"
            />
            {!picked && query.trim().length >= 2 && (
              <div className="max-h-40 w-full overflow-auto rounded border border-neutral-200 bg-white text-sm shadow-sm sm:w-64">
                {search.isLoading && <div className="px-2 py-1 text-neutral-500">Searching…</div>}
                {search.data?.length === 0 && (
                  <div className="px-2 py-1 text-neutral-500">No matches</div>
                )}
                {search.data?.map((f) => {
                  const display = f.name ?? 'Unnamed family'
                  const label = f.billingContactName ? `${display} · ${f.billingContactName}` : display
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => {
                        setPicked({ id: f.id, label })
                        setError(null)
                      }}
                      className="block w-full px-2 py-1 text-left hover:bg-neutral-100"
                    >
                      {label}{' '}
                      <span className="text-neutral-400">({f.state})</span>
                    </button>
                  )
                })}
              </div>
            )}
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={resolve.isPending || !picked}>
                {resolve.isPending ? 'Linking…' : 'Link'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setMode('idle')
                  setError(null)
                  setPicked(null)
                  setQuery('')
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {mode === 'dismiss' && (
          <form onSubmit={handleDismiss} className="space-y-2">
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why dismiss? (e.g. test charge)"
              className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm sm:w-64"
            />
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant="destructive" disabled={dismiss.isPending}>
                {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setMode('idle')
                  setError(null)
                  setReason('')
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Td>
    </Tr>
  )
}
