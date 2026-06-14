'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

import type { EnrollmentRow as Row } from '../types'

type Status = 'pending_review' | 'active' | 'paused' | 'expired' | 'cancelled'

type View = 'all' | 'review' | 'active'

const STATUS_TONE: Record<string, 'success' | 'warn' | 'neutral' | 'danger' | 'info'> = {
  active: 'success',
  pending_review: 'warn',
  paused: 'neutral',
  expired: 'danger',
  cancelled: 'neutral',
}

export function EnrollmentsManager({
  initialAll,
  initialReview,
  initialView,
  canManage,
}: {
  initialAll: Row[]
  initialReview: Row[]
  initialView: View
  canManage: boolean
}) {
  const utils = trpc.useUtils()
  const [view, setView] = useState<View>(initialView)

  const all = trpc.webinar.enrollment.list.useQuery({}, { initialData: initialAll })
  const review = trpc.webinar.enrollment.list.useQuery(
    { status: 'pending_review' },
    { initialData: initialReview },
  )

  const refresh = () => {
    void utils.webinar.enrollment.list.invalidate()
  }

  const detect = trpc.webinar.enrollment.detectFromStripe.useMutation({
    onSuccess: (r) => {
      if (r.errors.length > 0) {
        toast.error(r.errors[0])
      } else {
        toast.success(
          `Scanned ${r.scanned} subscriptions · ${r.autoEnrolled} enrolled · ${r.pendingReview} to review · ${r.contactsCreated} new contacts`,
        )
      }
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const setStatus = trpc.webinar.enrollment.setStatus.useMutation({
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })
  const remove = trpc.webinar.enrollment.remove.useMutation({
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })

  const rows = (view === 'review' ? review.data : all.data ?? []) ?? []
  const filtered = view === 'active' ? rows.filter((r) => r.status === 'active') : rows

  return (
    <div className="space-y-5">
      {canManage ? (
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">Detect from Stripe</h2>
                <p className="mt-1 text-xs text-neutral-500">
                  Reads your active Stripe subscriptions, works out each one&apos;s subject &amp;
                  level, and organises payers into the matching group for the current academic year.
                  New payers become contacts automatically. Safe to run repeatedly.
                </p>
              </div>
              <Button onClick={() => detect.mutate({ useAi: true })} disabled={detect.isPending}>
                {detect.isPending ? 'Scanning Stripe…' : 'Detect from Stripe'}
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="flex gap-1">
        {(['all', 'review', 'active'] as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={
              'rounded-md px-3 py-1.5 text-sm ' +
              (view === v
                ? 'bg-primary-50 font-medium text-primary-800'
                : 'text-neutral-600 hover:bg-neutral-100')
            }
          >
            {v === 'all' ? 'All' : v === 'review' ? `Review queue (${review.data?.length ?? 0})` : 'Active'}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-neutral-500">
              {view === 'review'
                ? 'Nothing waiting for review.'
                : 'No enrolments yet — run "Detect from Stripe" above.'}
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="p-0">
            <div className="divide-y divide-neutral-100">
              {filtered.map((e) => (
                <div
                  key={e.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-neutral-900">{e.contactName}</span>
                      <Badge tone="info">{e.classLabel}</Badge>
                      <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{e.status}</Badge>
                      {e.source === 'ai_advisory' ? <Badge tone="accent">AI</Badge> : null}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-neutral-500">
                      {e.contactEmail}
                      {e.matchReason ? ` · ${e.matchReason}` : ''}
                      {e.expiresAt
                        ? ` · expires ${new Date(e.expiresAt).toLocaleDateString('en-GB')}`
                        : ''}
                    </div>
                  </div>
                  {canManage ? (
                    <div className="flex items-center gap-2">
                      {e.status === 'pending_review' ? (
                        <Button
                          size="sm"
                          onClick={() => setStatus.mutate({ id: e.id, status: 'active' })}
                        >
                          Confirm &amp; enrol
                        </Button>
                      ) : null}
                      <Select
                        value={e.status}
                        onChange={(ev) =>
                          setStatus.mutate({ id: e.id, status: ev.target.value as Status })
                        }
                      >
                        <option value="active">Active</option>
                        <option value="pending_review">Pending review</option>
                        <option value="paused">Paused</option>
                        <option value="expired">Expired</option>
                        <option value="cancelled">Cancelled</option>
                      </Select>
                      <Button variant="ghost" size="xs" onClick={() => remove.mutate({ id: e.id })}>
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      <p className="text-xs text-neutral-400">
        Manage a specific class&apos;s roster from{' '}
        <Link href="/webinars/classes" className="underline">
          Classes
        </Link>
        .
      </p>
    </div>
  )
}
