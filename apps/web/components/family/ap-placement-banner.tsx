'use client'

// AP placement banner. Shown on the Family detail page when an AP placement
// exists; the overdue indicator + "Complete review" action call the
// lacontract.completeApReview audited mutation. CLAUDE.md §43.4.

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

export interface ApPlacementBannerProps {
  familyId: string
  statutoryReason: string | null
  apStartDate: string | null
  apReviewDate: string | null
  reviewStatus: string | null
  overdue: boolean
}

export function ApPlacementBanner(props: ApPlacementBannerProps) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const m = trpc.lacontract.completeApReview.useMutation({
    onSuccess: () => {
      setPending(false)
      router.refresh()
    },
    onError: (e) => {
      setPending(false)
      setError(e.message)
    },
  })

  const tone = props.overdue
    ? 'border-red-300 bg-red-50 text-red-900'
    : 'border-blue-200 bg-blue-50 text-blue-900'

  const reviewDate = props.apReviewDate ? new Date(props.apReviewDate) : null

  return (
    <div className={`rounded-md border p-4 text-sm ${tone}`} role="region" aria-label="AP placement">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">
            AP placement
            {props.overdue ? (
              <span className="ml-2 rounded bg-red-200 px-2 py-0.5 text-xs uppercase tracking-wide">
                Review overdue
              </span>
            ) : null}
          </h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <dt className="text-neutral-500">Statutory reason</dt>
            <dd>{props.statutoryReason ?? '—'}</dd>
            <dt className="text-neutral-500">Start</dt>
            <dd>
              {props.apStartDate
                ? new Date(props.apStartDate).toLocaleDateString('en-GB')
                : '—'}
            </dd>
            <dt className="text-neutral-500">Review</dt>
            <dd>{reviewDate ? reviewDate.toLocaleDateString('en-GB') : '—'}</dd>
            <dt className="text-neutral-500">Status</dt>
            <dd>{props.reviewStatus ?? 'pending'}</dd>
          </dl>
        </div>
        <Button
          type="button"
          variant={props.overdue ? 'destructive' : 'secondary'}
          disabled={pending || props.reviewStatus === 'completed'}
          onClick={() => {
            setError(null)
            setPending(true)
            m.mutate({ familyId: props.familyId })
          }}
        >
          {props.reviewStatus === 'completed' ? 'Review completed' : 'Complete review'}
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
