// At-risk customers dashboard (client island). Renders the scored rows from
// customerRisk.list and adds per-row triage: flag / dismiss / clear, and a
// "Create task" modal that opens a follow-up Task against the customer and
// flags them in one go. View + level lenses live in the URL so the view is
// shareable. CLAUDE.md §26 (client leaf), §27 (mutations via tRPC).

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { trpc } from '@/lib/trpc/client'

type Level = 'none' | 'low' | 'medium' | 'high'
type View = 'open' | 'flagged' | 'dismissed' | 'all'

interface LabelChip {
  id: string
  name: string
  color: string | null
}

export interface RiskRow {
  id: string
  name: string
  email: string | null
  phoneE164: string | null
  hoursBooked: number | null
  hoursDelivered: number | null
  hoursRemaining: number
  daysToExpiry: number | null
  level: Level
  score: number
  reasons: string[]
  labels: LabelChip[]
  reviewStatus: 'flagged' | 'dismissed' | null
  reviewNote: string | null
  openTaskCount: number
}

interface Counts {
  high: number
  medium: number
  low: number
  flagged: number
  total: number
}

const LEVEL_BADGE: Record<string, string> = {
  high: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  medium: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  low: 'bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200',
}
const LEVEL_LABEL: Record<string, string> = {
  high: 'High risk',
  medium: 'At risk',
  low: 'Watch',
}

const CAN_REVIEW = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])

export function AtRiskDashboard({
  items,
  counts,
  minLevel,
  view,
  role,
}: {
  items: RiskRow[]
  counts: Counts
  minLevel: 'low' | 'medium' | 'high'
  view: View
  role: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const utils = trpc.useUtils()
  const canReview = CAN_REVIEW.has(role)
  const [taskFor, setTaskFor] = useState<RiskRow | null>(null)

  const setReview = trpc.customerRisk.setReview.useMutation()
  const clearReview = trpc.customerRisk.clearReview.useMutation()

  function refresh() {
    void utils.customerRisk.list.invalidate()
    router.refresh()
  }

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set(key, value)
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  async function flag(row: RiskRow) {
    await setReview.mutateAsync({ contactId: row.id, status: 'flagged', levelAtReview: row.level })
    toast.success(`Flagged ${row.name}`)
    refresh()
  }
  async function dismiss(row: RiskRow) {
    await setReview.mutateAsync({ contactId: row.id, status: 'dismissed', levelAtReview: row.level })
    toast.success(`Dismissed ${row.name}`)
    refresh()
  }
  async function clear(row: RiskRow) {
    await clearReview.mutateAsync({ contactId: row.id })
    toast.success(`Cleared review for ${row.name}`)
    refresh()
  }

  const VIEWS: Array<{ key: View; label: string }> = [
    { key: 'open', label: 'Open' },
    { key: 'flagged', label: `Flagged${counts.flagged ? ` (${counts.flagged})` : ''}` },
    { key: 'dismissed', label: 'Dismissed' },
    { key: 'all', label: 'All' },
  ]

  return (
    <div className="space-y-4">
      {/* View + level lenses + counts. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-card">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setParam('view', v.key)}
              className={
                view === v.key
                  ? 'rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white'
                  : 'rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100'
              }
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5">
          {(['high', 'medium', 'low'] as const).map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => setParam('level', lvl)}
              className={
                minLevel === lvl
                  ? 'rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white'
                  : 'rounded-md px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100'
              }
            >
              {lvl === 'high' ? 'High only' : lvl === 'medium' ? 'At risk +' : 'Watch +'}
            </button>
          ))}
        </div>

        <span className="ml-1 text-sm text-neutral-500">
          <span className="font-semibold text-red-700">{counts.high}</span> high ·{' '}
          <span className="font-semibold text-amber-700">{counts.medium}</span> at risk
        </span>
      </div>

      {items.length === 0 ? (
        <Card>
          <div className="px-10 py-14 text-center">
            <p className="text-sm font-medium text-neutral-800">Nothing here right now.</p>
            <p className="mt-1 text-xs text-neutral-500">
              Customers appear when they hold a meaningful unused-hours balance — especially as the
              12-month expiry approaches. Figures sync from booking.studymind.co.uk.
            </p>
          </div>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[1000px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-neutral-50/95 text-left backdrop-blur">
              <tr className="border-b border-neutral-200">
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Customer
                </th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Risk
                </th>
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Booked
                </th>
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Done
                </th>
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Left
                </th>
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Expires in
                </th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Why
                </th>
                {canReview && <th className="px-3 py-2.5 text-right" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {items.map((c) => (
                <tr key={c.id} className="group align-top transition-colors hover:bg-neutral-50/80">
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={c.name} size={32} className="ring-2 ring-neutral-100" />
                      <span className="min-w-0">
                        <Link
                          href={`/contacts/${c.id}`}
                          className="block truncate font-medium text-neutral-900 hover:text-primary-700"
                        >
                          {c.name}
                        </Link>
                        <span className="mt-0.5 flex items-center gap-2 text-xs">
                          <EmailLink email={c.email} />
                          <PhoneLink phone={c.phoneE164} />
                        </span>
                        {(c.labels.length > 0 || c.openTaskCount > 0) && (
                          <span className="mt-1 flex flex-wrap items-center gap-1">
                            {c.openTaskCount > 0 && (
                              <span className="rounded-full bg-primary-50 px-1.5 py-0.5 text-[10px] font-medium text-primary-700">
                                {c.openTaskCount} open task{c.openTaskCount === 1 ? '' : 's'}
                              </span>
                            )}
                            {c.labels.map((l) => (
                              <span
                                key={l.id}
                                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                style={{
                                  backgroundColor: `${l.color ?? '#94a3b8'}1a`,
                                  color: l.color ?? '#475569',
                                }}
                              >
                                {l.name}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex flex-col items-start gap-1">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${LEVEL_BADGE[c.level]}`}
                      >
                        {LEVEL_LABEL[c.level]}
                      </span>
                      {c.reviewStatus === 'flagged' && (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          Flagged
                        </span>
                      )}
                      {c.reviewStatus === 'dismissed' && (
                        <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-500">
                          Dismissed
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-neutral-600">
                    {c.hoursBooked != null ? `${c.hoursBooked}h` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-neutral-600">
                    {c.hoursDelivered != null ? `${c.hoursDelivered}h` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-neutral-900">
                    {c.hoursRemaining}h
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-xs tabular-nums ${
                      c.daysToExpiry != null && c.daysToExpiry <= 30
                        ? 'font-semibold text-red-700'
                        : 'text-neutral-600'
                    }`}
                  >
                    {c.daysToExpiry == null ? '—' : c.daysToExpiry <= 0 ? 'now' : `${c.daysToExpiry}d`}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-600">{c.reasons[0] ?? '—'}</td>
                  {canReview && (
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => setTaskFor(c)}
                        >
                          Create task
                        </Button>
                        {c.reviewStatus === 'flagged' ? (
                          <button
                            type="button"
                            onClick={() => clear(c)}
                            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
                          >
                            Unflag
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => flag(c)}
                            className="rounded px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50"
                          >
                            Flag
                          </button>
                        )}
                        {c.reviewStatus === 'dismissed' ? (
                          <button
                            type="button"
                            onClick={() => clear(c)}
                            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
                          >
                            Restore
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => dismiss(c)}
                            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
                          >
                            Dismiss
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {taskFor && (
        <CreateTaskModal row={taskFor} onClose={() => setTaskFor(null)} onDone={refresh} />
      )}
    </div>
  )
}

function CreateTaskModal({
  row,
  onClose,
  onDone,
}: {
  row: RiskRow
  onClose: () => void
  onDone: () => void
}) {
  const expiry =
    row.daysToExpiry == null
      ? ''
      : row.daysToExpiry <= 0
        ? ' (expiring now)'
        : ` (expires in ${row.daysToExpiry}d)`
  const [title, setTitle] = useState(
    `Chase ${row.hoursRemaining}h unused hours${expiry} — ${row.name}`,
  )
  const [assigneeId, setAssigneeId] = useState('')
  const [due, setDue] = useState('')
  const [note, setNote] = useState(row.reasons.join('; '))

  const usersQuery = trpc.task.assignableUsers.useQuery({})
  const users = usersQuery.data ?? []
  const create = trpc.customerRisk.createTask.useMutation({
    onSuccess: () => {
      toast.success('Task created and customer flagged')
      onClose()
      onDone()
    },
    onError: (e) => toast.error(e.message),
  })

  function submit() {
    if (!title.trim()) {
      toast.error('Give the task a title')
      return
    }
    if (!assigneeId) {
      toast.error('Pick an assignee')
      return
    }
    create.mutate({
      contactId: row.id,
      title: title.trim(),
      assigneeId,
      note: note.trim() || undefined,
      dueAt: due ? new Date(due) : undefined,
      alsoFlag: true,
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-neutral-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-neutral-900">Create follow-up task</h2>
        <p className="mt-0.5 text-xs text-neutral-500">
          Opens a task against {row.name} and flags them as being handled.
        </p>

        <div className="mt-4 space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-600">Title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-600">Assignee</span>
              <select
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm"
              >
                <option value="">Select…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name ?? u.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-600">Due (optional)</span>
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-600">Note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-neutral-300 bg-white p-2 text-sm focus:border-primary-500 focus:outline-none"
            />
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-neutral-500 hover:underline"
          >
            Cancel
          </button>
          <Button type="button" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create task'}
          </Button>
        </div>
      </div>
    </div>
  )
}
