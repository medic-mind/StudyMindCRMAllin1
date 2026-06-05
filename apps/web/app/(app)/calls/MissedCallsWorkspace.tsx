// Client island for the missed-calls queue. Filter chips + window selector are
// URL-driven (server re-renders); per-row actions (mark actioned / dismiss /
// reopen) are tRPC mutations. Click-to-call uses the shared PhoneLink so a
// callback flows straight into Aircall — and the next list load shows the call
// auto-resolved. CLAUDE.md §10.

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { PhoneLink } from '@/components/shared/channel-links'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

type Filter = 'outstanding' | 'called_back' | 'all'
type State = 'outstanding' | 'called_back' | 'actioned' | 'dismissed'

interface Item {
  callKey: string
  aircallCallId: string | null
  occurredAt: string | Date
  phone: string | null
  contactId: string | null
  contactName: string | null
  contactKind: string | null
  isVoicemail: boolean
  state: State
  calledBackAt: string | Date | null
  reviewStatus: 'actioned' | 'dismissed' | null
  reviewNote: string | null
}

interface Counts {
  outstanding: number
  calledBack: number
  actioned: number
  dismissed: number
  total: number
}

interface Props {
  items: Item[]
  counts: Counts
  filter: Filter
  days: number
  canAction: boolean
}

const STATE_LABEL: Record<State, string> = {
  outstanding: 'Outstanding',
  called_back: 'Called back',
  actioned: 'Actioned',
  dismissed: 'Dismissed',
}
const STATE_TONE: Record<State, BadgeTone> = {
  outstanding: 'warn',
  called_back: 'success',
  actioned: 'info',
  dismissed: 'neutral',
}

function fmtDateTime(d: string | Date): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(d),
  )
}

export function MissedCallsWorkspace({ items, counts, filter, days, canAction }: Props) {
  const router = useRouter()
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const onSettled = () => {
    setBusyKey(null)
    router.refresh()
  }
  const setReview = trpc.calls.missed.setReview.useMutation({
    onSuccess: () => toast.success('Updated'),
    onError: (e) => toast.error(e.message ?? 'Could not update'),
    onSettled,
  })
  const clearReview = trpc.calls.missed.clearReview.useMutation({
    onSuccess: () => toast.success('Reopened'),
    onError: (e) => toast.error(e.message ?? 'Could not update'),
    onSettled,
  })

  const now = new Date()

  const chips: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'outstanding', label: 'Outstanding', count: counts.outstanding },
    { key: 'called_back', label: 'Called back', count: counts.calledBack },
    { key: 'all', label: 'All', count: counts.total },
  ]
  const windows = [30, 90, 365] as const

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filter">
          {chips.map((c) => {
            const active = filter === c.key
            return (
              <Link
                key={c.key}
                role="tab"
                aria-selected={active}
                href={`/calls?filter=${c.key}&days=${days}`}
                className={
                  active
                    ? 'inline-flex items-center gap-1.5 rounded-full bg-primary-600 px-3 py-1 text-xs font-medium text-white shadow-sm'
                    : 'inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900'
                }
              >
                {c.label}
                <span
                  className={
                    active
                      ? 'rounded-full bg-white/25 px-1.5 text-[10px] tabular-nums'
                      : 'rounded-full bg-neutral-100 px-1.5 text-[10px] tabular-nums text-neutral-600'
                  }
                >
                  {c.count}
                </span>
              </Link>
            )
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-neutral-500">Window</span>
          {windows.map((w) => {
            const active = days === w
            return (
              <Link
                key={w}
                href={`/calls?filter=${filter}&days=${w}`}
                className={
                  active
                    ? 'inline-flex items-center rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white'
                    : 'inline-flex items-center rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50'
                }
              >
                {w === 365 ? '1y' : `${w}d`}
              </Link>
            )
          })}
        </div>
      </div>

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <p className="p-8 text-center text-sm text-neutral-500">
            {filter === 'outstanding'
              ? 'No missed calls to chase — you are all caught up.'
              : 'No calls match this filter in the selected window.'}
          </p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Caller</Th>
                <Th>When</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </Thead>
            <Tbody>
              {items.map((it) => {
                const busy = busyKey === it.callKey
                const calledBack = it.calledBackAt ? new Date(it.calledBackAt) : null
                return (
                  <Tr key={it.callKey}>
                    <Td>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={it.contactName ?? it.phone ?? '?'} size={28} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm">
                            {it.contactId ? (
                              <Link
                                href={`/contacts/${it.contactId}`}
                                className="truncate font-medium text-neutral-900 hover:text-primary-700 hover:underline"
                              >
                                {it.contactName ?? 'Contact'}
                              </Link>
                            ) : (
                              <span className="truncate font-medium text-neutral-500">
                                Unknown number
                              </span>
                            )}
                            {it.isVoicemail ? <Badge tone="warn">Voicemail</Badge> : null}
                          </div>
                          <div className="text-xs text-neutral-500">
                            <PhoneLink phone={it.phone} />
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <div className="text-sm text-neutral-700">
                        {formatRelativeTime(new Date(it.occurredAt), now)}
                      </div>
                      <div className="text-xs text-neutral-400">{fmtDateTime(it.occurredAt)}</div>
                    </Td>
                    <Td>
                      <Badge tone={STATE_TONE[it.state]} dot>
                        {STATE_LABEL[it.state]}
                      </Badge>
                      {it.state === 'called_back' && calledBack ? (
                        <div className="mt-0.5 text-xs text-neutral-500">
                          {formatRelativeTime(calledBack, now)}
                        </div>
                      ) : null}
                      {it.reviewNote ? (
                        <div className="mt-0.5 max-w-[16rem] truncate text-xs italic text-neutral-400" title={it.reviewNote}>
                          {it.reviewNote}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-right">
                      {canAction && it.aircallCallId ? (
                        it.reviewStatus ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setBusyKey(it.callKey)
                              clearReview.mutate({ aircallCallId: it.aircallCallId as string })
                            }}
                            className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-50"
                          >
                            Reopen
                          </button>
                        ) : (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setBusyKey(it.callKey)
                                setReview.mutate({
                                  aircallCallId: it.aircallCallId as string,
                                  status: 'actioned',
                                })
                              }}
                              className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                            >
                              Mark actioned
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setBusyKey(it.callKey)
                                setReview.mutate({
                                  aircallCallId: it.aircallCallId as string,
                                  status: 'dismissed',
                                })
                              }}
                              className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-50 disabled:opacity-50"
                              title="Spam or not worth a callback"
                            >
                              Dismiss
                            </button>
                          </div>
                        )
                      ) : (
                        <span className="text-xs text-neutral-300">—</span>
                      )}
                    </Td>
                  </Tr>
                )
              })}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
