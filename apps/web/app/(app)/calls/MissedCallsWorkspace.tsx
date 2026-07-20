// Client island for the missed-calls queue. Filter chips + window selector are
// URL-driven (server re-renders); per-row actions (mark actioned / dismiss /
// reopen) are tRPC mutations. Click-to-call uses the shared PhoneLink so a
// callback flows straight into Aircall — and the next list load shows the call
// auto-resolved. CLAUDE.md §10.

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { PhoneLink } from '@/components/shared/channel-links'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { Toolbar } from '@/components/ui/toolbar'
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

interface SyncHealth {
  apiConfigured: boolean
  lastSyncAt: string | Date | null
  lastSyncSuccess: boolean | null
  outboundInWindow: number
  inboundInWindow: number
}

interface Props {
  items: Item[]
  counts: Counts
  filter: Filter
  days: number
  canAction: boolean
  health: SyncHealth
}

/**
 * Explains why "called back" detection can't work, when the data says it
 * can't. Detection needs OUTBOUND calls to reach the CRM (a later outbound
 * call to the same number clears the miss). If the window holds inbound calls
 * but not a single outbound one, or the sync cron has never run / is stale,
 * the problem is the Aircall feed — not the agent's callbacks.
 */
function syncProblem(h: SyncHealth, days: number): string | null {
  if (!h.apiConfigured && !h.lastSyncAt) {
    return 'The Aircall API is not configured (AIRCALL_API_ID / AIRCALL_API_TOKEN), so the 10-minute call sync is off. Callbacks made inside Aircall never reach the CRM, so they cannot clear missed calls. Add the API credentials in Railway, or check the Aircall webhook subscribes to outbound call events.'
  }
  if (h.lastSyncAt) {
    const ageMin = (Date.now() - new Date(h.lastSyncAt).getTime()) / 60000
    if (ageMin > 60) {
      return `The Aircall call sync last ran ${Math.round(ageMin / 60)}h ago (it should run every 10 minutes). Recent calls — including your callbacks — are not being imported, so missed calls are not clearing. Check the worker service / Inngest.`
    }
    if (h.lastSyncSuccess === false) {
      return 'The most recent Aircall call sync failed. Recent callbacks may not have been imported yet, so some missed calls will not have cleared. Check the worker logs.'
    }
  }
  if (h.inboundInWindow > 0 && h.outboundInWindow === 0) {
    return `No outbound calls have reached the CRM in the last ${days} days, while ${h.inboundInWindow} inbound calls have. "Called back" is detected from outbound calls, so nothing can clear. This usually means the Aircall webhook only delivers inbound events and the API sync is not running — check AIRCALL_API_ID / AIRCALL_API_TOKEN.`
  }
  return null
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

export function MissedCallsWorkspace({ items, counts, filter, days, canAction, health }: Props) {
  const router = useRouter()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const problem = syncProblem(health, days)

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
  const bulkSetReview = trpc.calls.missed.bulkSetReview.useMutation()

  // Only Aircall-identified calls can be reviewed (a withheld number has no id).
  const selectableIds = useMemo(
    () => items.filter((i) => i.aircallCallId).map((i) => i.aircallCallId as string),
    [items],
  )
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))

  function toggleAll(next: boolean) {
    setSelected(next ? new Set(selectableIds) : new Set())
  }
  function toggleOne(id: string, next: boolean) {
    setSelected((prev) => {
      const s = new Set(prev)
      if (next) s.add(id)
      else s.delete(id)
      return s
    })
  }
  async function runBulk(status: 'actioned' | 'dismissed' | null) {
    const ids = [...selected]
    if (ids.length === 0) return
    setBulkBusy(true)
    try {
      const { count } = await bulkSetReview.mutateAsync({ aircallCallIds: ids, status })
      toast.success(
        status === null
          ? `Reopened ${count} call${count === 1 ? '' : 's'}`
          : `Marked ${count} call${count === 1 ? '' : 's'} ${status}`,
      )
      setSelected(new Set())
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the selected calls')
    } finally {
      setBulkBusy(false)
    }
  }

  const now = new Date()

  const chips: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'outstanding', label: 'Outstanding', count: counts.outstanding },
    { key: 'called_back', label: 'Called back', count: counts.calledBack },
    { key: 'all', label: 'All', count: counts.total },
  ]
  const windows = [30, 90, 365] as const

  return (
    <div className="space-y-4">
      {problem ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="font-semibold">Callbacks can&rsquo;t be detected right now</p>
          <p className="mt-1">{problem}</p>
        </div>
      ) : null}
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
          {canAction ? <SyncFromAircallButton /> : null}
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

      {canAction && selected.size > 0 ? (
        <Toolbar
          label={`${selected.size} selected`}
          clear={
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs font-medium text-neutral-500 hover:text-neutral-800"
            >
              Clear selection
            </button>
          }
        >
          <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => runBulk('actioned')}>
            Mark actioned
          </Button>
          <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => runBulk('dismissed')}>
            Dismiss
          </Button>
          <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => runBulk(null)}>
            Reopen
          </Button>
        </Toolbar>
      ) : null}

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
                {canAction ? (
                  <Th className="w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      disabled={selectableIds.length === 0}
                      onChange={(e) => toggleAll(e.target.checked)}
                      className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                    />
                  </Th>
                ) : null}
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
                const isSelected = Boolean(it.aircallCallId && selected.has(it.aircallCallId))
                return (
                  <Tr key={it.callKey} className={isSelected ? 'bg-primary-50/40' : undefined}>
                    {canAction ? (
                      <Td className="pr-0">
                        {it.aircallCallId ? (
                          <input
                            type="checkbox"
                            aria-label="Select call"
                            checked={isSelected}
                            onChange={(e) => toggleOne(it.aircallCallId as string, e.target.checked)}
                            className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                          />
                        ) : null}
                      </Td>
                    ) : null}
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

/**
 * Force an immediate pull of recent calls from Aircall (the 24h re-pull the
 * 10-minute cron does) — for when a specific missed call hasn't come through.
 * Then refreshes the page so the freshly-pulled calls show. Sales Exec+.
 */
function SyncFromAircallButton(): JSX.Element {
  const router = useRouter()
  const sync = trpc.calls.missed.syncNow.useMutation({
    onSuccess: (r) => {
      if (!r.configured) {
        toast.error('Aircall API keys are not set — ask an admin to configure AIRCALL_API_ID / AIRCALL_API_TOKEN.')
        return
      }
      toast.success('Syncing recent calls from Aircall — refresh in a few seconds to see them.')
      // Give the background pull a moment, then refresh the server data.
      setTimeout(() => router.refresh(), 4000)
    },
    onError: (e) => toast.error(e.message ?? 'Could not start the sync'),
  })
  return (
    <button
      type="button"
      onClick={() => sync.mutate()}
      disabled={sync.isPending}
      className="inline-flex items-center rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
      title="Pull the last 24 hours of calls from Aircall now (in case a webhook was missed)"
    >
      {sync.isPending ? 'Syncing…' : 'Sync from Aircall'}
    </button>
  )
}
