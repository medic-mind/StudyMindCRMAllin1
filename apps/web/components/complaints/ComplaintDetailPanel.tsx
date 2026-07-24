// The full complaint workspace — customer, status/severity/assignee controls, a
// proper message thread (comments + action points) that logs onto the customer's
// CRM timeline and mirrors into the Slack #complaintcallsummaries thread, and the
// whole lifecycle (resolve / dismiss / reopen / archive / delete / permanently
// delete). Shared by the /complaints/[id] page AND the contact page's Complaints
// section so both behave identically. CLAUDE.md §26.

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ArchiveIcon, CheckCircleIcon, HashIcon, UserCircleIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'
import { complaintStatusTone } from '@/lib/ui/status-tone'
import { formatRelativeTime } from '@/lib/format/relative-time'

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}
const SEVERITY_CLS: Record<string, string> = {
  high: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  medium: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  low: 'bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200',
}

export function ComplaintDetailPanel({
  complaintId,
  onChanged,
  onDeleted,
}: {
  complaintId: string
  /** Called after any mutation so a parent list can refresh. */
  onChanged?: () => void | Promise<void>
  /** Called after a (soft or hard) delete — the parent removes/navigates. */
  onDeleted?: () => void
}) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const getQuery = trpc.complaint.get.useQuery({ id: complaintId })
  const c = getQuery.data
  const assignable = trpc.complaint.assignableUsers.useQuery(undefined, { staleTime: 5 * 60_000 })

  const [note, setNote] = useState('')
  const [isAction, setIsAction] = useState(false)
  const [resolution, setResolution] = useState('')
  const [busy, setBusy] = useState(false)

  const addUpdate = trpc.complaint.addUpdate.useMutation()
  const setDone = trpc.complaint.setActionPointDone.useMutation()
  const resolve = trpc.complaint.resolve.useMutation()
  const reopen = trpc.complaint.reopen.useMutation()
  const update = trpc.complaint.update.useMutation()
  const archive = trpc.complaint.archive.useMutation()
  const del = trpc.complaint.delete.useMutation()
  const purge = trpc.complaint.permanentlyDelete.useMutation()

  async function refresh() {
    await utils.complaint.get.invalidate({ id: complaintId })
    await utils.complaint.list.invalidate()
    await utils.complaint.activeCount.invalidate()
    if (onChanged) await onChanged()
  }

  if (getQuery.isLoading || !c) {
    return <div className="px-3 py-4 text-sm text-neutral-400">Loading…</div>
  }

  const isActive = c.status === 'open' || c.status === 'in_progress'

  async function submitNote() {
    const body = note.trim()
    if (!body) return
    setBusy(true)
    try {
      await addUpdate.mutateAsync({ complaintId, body, isActionPoint: isAction })
      setNote('')
      setIsAction(false)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add the update')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Customer + meta */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {c.contactId ? (
              <Link
                href={`/contacts/${c.contactId}`}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-900 hover:text-primary-700 hover:underline"
              >
                <UserCircleIcon size={14} /> {c.customerName}
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
                <UserCircleIcon size={14} /> {c.customerName}
                <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
                  Manual — not in CRM
                </span>
              </span>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-neutral-500">
            {c.customerPhone ? <span>{c.customerPhone}</span> : null}
            {c.customerEmail ? <span>{c.customerEmail}</span> : null}
            <span>Raised {formatRelativeTime(new Date(c.createdAt), new Date())}</span>
            {c.postedToSlack ? (
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <HashIcon size={11} /> Posted to {c.slackChannelName ?? '#complaintcallsummaries'}
              </span>
            ) : (
              <span className="text-amber-600">Not posted to Slack</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
              SEVERITY_CLS[c.severity] ?? SEVERITY_CLS.low
            }`}
          >
            {c.severity}
          </span>
          <Badge tone={complaintStatusTone(c.status)}>{STATUS_LABEL[c.status] ?? c.status}</Badge>
          {c.archived ? (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">
              Archived
            </span>
          ) : null}
        </div>
      </div>

      {c.description ? (
        <p className="whitespace-pre-wrap rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
          {c.description}
        </p>
      ) : null}

      {/* Status / severity / assignee controls */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          Status
        </label>
        <Select
          value={c.status}
          onChange={async (e) => {
            await update.mutateAsync({ id: complaintId, status: e.target.value as 'open' })
            await refresh()
          }}
        >
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
        </Select>
        <Select
          value={c.severity}
          onChange={async (e) => {
            await update.mutateAsync({ id: complaintId, severity: e.target.value as 'low' })
            await refresh()
          }}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>
        <Select
          value={c.assigneeId ?? ''}
          onChange={async (e) => {
            await update.mutateAsync({ id: complaintId, assigneeId: e.target.value || null })
            await refresh()
          }}
        >
          <option value="">Unassigned</option>
          {(assignable.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </div>

      {/* Thread */}
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Thread · logged to the CRM {c.postedToSlack ? '+ Slack' : ''}
        </p>
        {c.updates.length === 0 ? (
          <p className="text-xs text-neutral-400">
            No messages yet — add the first update below to start the thread.
          </p>
        ) : (
          <ul className="space-y-2">
            {c.updates.map((u) => (
              <li key={u.id} className="flex items-start gap-2 text-sm">
                {u.isActionPoint ? (
                  <input
                    type="checkbox"
                    checked={u.done}
                    onChange={async (e) => {
                      await setDone.mutateAsync({ updateId: u.id, done: e.target.checked })
                      await refresh()
                    }}
                    className="mt-1 h-3.5 w-3.5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                    aria-label="Action point done"
                  />
                ) : (
                  <span aria-hidden className="mt-1 text-neutral-300">
                    •
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className={u.done ? 'text-neutral-400 line-through' : 'text-neutral-700'}>
                    {u.body}
                    {u.isActionPoint ? (
                      <span className="ml-1 rounded bg-primary-50 px-1 text-[9px] font-semibold uppercase text-primary-700">
                        action
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-neutral-400">
                    {u.authorName ? `${u.authorName} · ` : ''}
                    {formatRelativeTime(new Date(u.createdAt), new Date())}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 space-y-1.5">
          <Textarea
            rows={2}
            placeholder="Add a message or action point — sent to the CRM record and the Slack thread…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs text-neutral-600">
              <input
                type="checkbox"
                checked={isAction}
                onChange={(e) => setIsAction(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              />
              Mark as an action point
            </label>
            <Button size="sm" variant="secondary" disabled={busy || !note.trim()} onClick={submitNote}>
              {busy ? 'Adding…' : 'Add to thread'}
            </Button>
          </div>
        </div>
      </div>

      {/* Lifecycle actions */}
      <div className="space-y-2 border-t border-neutral-100 pt-3">
        {isActive ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Resolution (optional)…"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              className="max-w-xs"
            />
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await resolve.mutateAsync({ id: complaintId, resolution: resolution.trim() || undefined })
                  toast.success('Complaint resolved')
                  setResolution('')
                  await refresh()
                } finally {
                  setBusy(false)
                }
              }}
            >
              <CheckCircleIcon size={14} /> Resolve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                await resolve.mutateAsync({
                  id: complaintId,
                  dismiss: true,
                  resolution: resolution.trim() || undefined,
                })
                toast('Complaint dismissed')
                setResolution('')
                await refresh()
              }}
            >
              Dismiss
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {c.resolution ? <span className="text-xs text-neutral-500">{c.resolution}</span> : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await reopen.mutateAsync({ id: complaintId })
                toast('Complaint reopened')
                await refresh()
              }}
            >
              Reopen
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await archive.mutateAsync({ id: complaintId, archived: !c.archived })
              toast(c.archived ? 'Complaint unarchived' : 'Complaint archived')
              await refresh()
            }}
          >
            <ArchiveIcon size={14} /> {c.archived ? 'Unarchive' : 'Archive'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (!window.confirm('Delete this complaint? It can be restored later.')) return
              await del.mutateAsync({ id: complaintId })
              toast('Complaint deleted')
              if (onDeleted) onDeleted()
              else router.push('/complaints')
            }}
          >
            Delete
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600 hover:text-red-700"
            onClick={async () => {
              if (
                !window.confirm(
                  'Permanently delete this complaint and its whole thread? This cannot be undone.',
                )
              )
                return
              await purge.mutateAsync({ id: complaintId })
              toast('Complaint permanently deleted')
              if (onDeleted) onDeleted()
              else router.push('/complaints')
            }}
          >
            Permanently delete
          </Button>
        </div>
      </div>
    </div>
  )
}
