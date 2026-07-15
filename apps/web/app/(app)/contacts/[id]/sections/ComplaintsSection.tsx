// Complaints on the contact page. Log a complaint, work it with follow-ups +
// action points, convert it to a Task, and resolve it. Every customer-facing
// step is mirrored onto the contact timeline server-side. Any staff can log
// and resolve (product decision). CLAUDE.md §26.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SuggestInput } from '@/components/ui/suggest-input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'
import { formatRelativeTime } from '@/lib/format/relative-time'

type Severity = 'low' | 'medium' | 'high'

const STATUS_TONE: Record<string, BadgeTone> = {
  open: 'danger',
  in_progress: 'info',
  resolved: 'success',
  dismissed: 'neutral',
}
const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}
const SEVERITY_CLS: Record<Severity, string> = {
  high: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  medium: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  low: 'bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200',
}

export function ComplaintsSection({ contactId }: { contactId: string }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const listQuery = trpc.complaint.list.useQuery({ contactId, filter: 'all' })
  const complaints = listQuery.data ?? []

  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('medium')
  const [category, setCategory] = useState('')
  const [withTask, setWithTask] = useState(false)
  const [taskAssigneeId, setTaskAssigneeId] = useState('')
  const [taskDue, setTaskDue] = useState('')
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const create = trpc.complaint.create.useMutation()
  // Preset themes + every category already in use; staff can also type new.
  const categoriesQuery = trpc.complaint.categories.useQuery(undefined, { enabled: adding })
  const usersQuery = trpc.task.assignableUsers.useQuery({}, { enabled: adding && withTask })

  async function refresh() {
    await Promise.all([
      utils.complaint.list.invalidate({ contactId }),
      utils.complaint.activeCount.invalidate(),
    ])
    router.refresh()
  }

  async function submitNew() {
    if (title.trim().length < 2) {
      toast.error('Give the complaint a short title.')
      return
    }
    if (withTask && !taskAssigneeId) {
      toast.error('Pick who the follow-up task is for, or untick the task option.')
      return
    }
    setBusy(true)
    try {
      const result = await create.mutateAsync({
        contactId,
        title: title.trim(),
        description: description.trim() || undefined,
        severity,
        category: category.trim() || undefined,
        task:
          withTask && taskAssigneeId
            ? {
                assigneeId: taskAssigneeId,
                dueAt: taskDue ? new Date(`${taskDue}T17:00:00`) : undefined,
              }
            : undefined,
      })
      toast.success(result.taskId ? 'Complaint logged and task assigned' : 'Complaint logged')
      setTitle('')
      setDescription('')
      setSeverity('medium')
      setCategory('')
      setWithTask(false)
      setTaskAssigneeId('')
      setTaskDue('')
      setAdding(false)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not log the complaint')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">
          {complaints.filter((c) => c.status === 'open' || c.status === 'in_progress').length}{' '}
          active · {complaints.length} total
        </p>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Log complaint
          </Button>
        )}
      </div>

      {adding && (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/40 p-3">
          <Input
            placeholder="What is the complaint? (short title)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            rows={3}
            placeholder="Details — what happened, what the customer is unhappy about…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
              <option value="low">Low severity</option>
              <option value="medium">Medium severity</option>
              <option value="high">High severity</option>
            </Select>
            {/* Pick a preset theme or type a brand-new one — both land in
                Complaint.category; new ones join the pick-list automatically.
                In-app suggestion panel (SuggestInput), not browser datalist. */}
            <SuggestInput
              className="w-full max-w-[14rem]"
              aria-label="Complaint category"
              placeholder="Category — pick or type new"
              options={categoriesQuery.data ?? []}
              value={category}
              onChange={setCategory}
            />
          </div>

          {/* Optional follow-up task, assigned as part of logging. */}
          <div className="rounded-md border border-neutral-200 bg-white p-2">
            <label className="flex items-center gap-2 text-sm text-neutral-800">
              <input
                type="checkbox"
                checked={withTask}
                onChange={(e) => setWithTask(e.target.checked)}
              />
              Assign a follow-up task to someone
            </label>
            {withTask && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Select
                  value={taskAssigneeId}
                  onChange={(e) => setTaskAssigneeId(e.target.value)}
                  aria-label="Task assignee"
                >
                  <option value="">Who is it for?</option>
                  {(usersQuery.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name ?? u.email}
                    </option>
                  ))}
                </Select>
                <Input
                  type="date"
                  className="max-w-[11rem]"
                  value={taskDue}
                  onChange={(e) => setTaskDue(e.target.value)}
                  aria-label="Task due date (optional)"
                />
                <span className="text-xs text-neutral-500">Due date optional</span>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={submitNew} disabled={busy || title.trim().length < 2}>
              {busy ? 'Saving…' : 'Log complaint'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {complaints.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-200 px-3 py-4 text-center text-xs text-neutral-500">
          No complaints logged for this customer.
        </p>
      ) : (
        <ul className="space-y-2">
          {complaints.map((c) => (
            <li key={c.id} className="rounded-lg border border-neutral-200">
              <button
                type="button"
                onClick={() => setOpenId(openId === c.id ? null : c.id)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {c.title}
                  </span>
                  <span className="text-[11px] text-neutral-500">
                    {formatRelativeTime(new Date(c.createdAt), new Date())}
                    {c.category ? ` · ${c.category}` : ''}
                    {c.updateCount > 0 ? ` · ${c.updateCount} update${c.updateCount === 1 ? '' : 's'}` : ''}
                    {c.taskId ? ' · task created' : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_CLS[c.severity as Severity] ?? SEVERITY_CLS.low}`}
                  >
                    {c.severity}
                  </span>
                  <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>
                    {STATUS_LABEL[c.status] ?? c.status}
                  </Badge>
                </span>
              </button>
              {openId === c.id && <ComplaintDetail id={c.id} onChanged={refresh} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ComplaintDetail({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const utils = trpc.useUtils()
  const getQuery = trpc.complaint.get.useQuery({ id })
  const c = getQuery.data
  const [note, setNote] = useState('')
  const [isAction, setIsAction] = useState(false)
  const [resolution, setResolution] = useState('')
  const [busy, setBusy] = useState(false)

  const addUpdate = trpc.complaint.addUpdate.useMutation()
  const setDone = trpc.complaint.setActionPointDone.useMutation()
  const resolve = trpc.complaint.resolve.useMutation()
  const reopen = trpc.complaint.reopen.useMutation()
  const createTask = trpc.complaint.createTask.useMutation()
  const update = trpc.complaint.update.useMutation()

  async function refreshDetail() {
    await utils.complaint.get.invalidate({ id })
    await onChanged()
  }

  if (!c) {
    return <div className="border-t border-neutral-100 px-3 py-3 text-xs text-neutral-400">Loading…</div>
  }

  const isActive = c.status === 'open' || c.status === 'in_progress'

  return (
    <div className="space-y-3 border-t border-neutral-100 bg-neutral-50/50 px-3 py-3">
      {c.description && <p className="whitespace-pre-wrap text-xs text-neutral-700">{c.description}</p>}

      {/* Status + severity controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={c.status}
          onChange={async (e) => {
            await update.mutateAsync({ id, status: e.target.value as 'open' })
            await refreshDetail()
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
            await update.mutateAsync({ id, severity: e.target.value as 'low' })
            await refreshDetail()
          }}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>
        {!c.taskId ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await createTask.mutateAsync({ id })
                toast.success('Follow-up task created')
                await refreshDetail()
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not create task')
              } finally {
                setBusy(false)
              }
            }}
          >
            Make a task
          </Button>
        ) : (
          <span className="text-[11px] text-neutral-500">Linked to a task ✓</span>
        )}
      </div>

      {/* Follow-ups + action points */}
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
          Follow-ups &amp; action points
        </p>
        {c.updates.length === 0 ? (
          <p className="text-xs text-neutral-400">No follow-ups yet — add an update below to keep the trail current.</p>
        ) : (
          <ul className="space-y-1">
            {c.updates.map((u) => (
              <li key={u.id} className="flex items-start gap-2 text-xs">
                {u.isActionPoint ? (
                  <input
                    type="checkbox"
                    checked={u.done}
                    onChange={async (e) => {
                      await setDone.mutateAsync({ updateId: u.id, done: e.target.checked })
                      await refreshDetail()
                    }}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                    aria-label="Action point done"
                  />
                ) : (
                  <span aria-hidden className="mt-0.5 text-neutral-300">
                    •
                  </span>
                )}
                <span className={u.done ? 'text-neutral-400 line-through' : 'text-neutral-700'}>
                  {u.body}
                  {u.isActionPoint ? (
                    <span className="ml-1 rounded bg-primary-50 px-1 text-[9px] font-semibold uppercase text-primary-700">
                      action
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-center gap-2">
          <Input
            placeholder="Add a follow-up or action point…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && note.trim()) {
                await addUpdate.mutateAsync({ complaintId: id, body: note.trim(), isActionPoint: isAction })
                setNote('')
                await refreshDetail()
              }
            }}
          />
          <label className="inline-flex shrink-0 items-center gap-1 text-[11px] text-neutral-600">
            <input
              type="checkbox"
              checked={isAction}
              onChange={(e) => setIsAction(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
            />
            action
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={!note.trim()}
            onClick={async () => {
              await addUpdate.mutateAsync({ complaintId: id, body: note.trim(), isActionPoint: isAction })
              setNote('')
              await refreshDetail()
            }}
          >
            Add
          </Button>
        </div>
      </div>

      {/* Resolve / reopen */}
      {isActive ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-2">
          <Input
            placeholder="Resolution (optional)…"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await resolve.mutateAsync({ id, resolution: resolution.trim() || undefined })
                toast.success('Complaint resolved')
                await refreshDetail()
              } finally {
                setBusy(false)
              }
            }}
          >
            Resolve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              await resolve.mutateAsync({ id, dismiss: true, resolution: resolution.trim() || undefined })
              toast('Complaint dismissed')
              await refreshDetail()
            }}
          >
            Dismiss
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-t border-neutral-100 pt-2">
          {c.resolution && <span className="text-xs text-neutral-500">{c.resolution}</span>}
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await reopen.mutateAsync({ id })
              await refreshDetail()
            }}
          >
            Reopen
          </Button>
        </div>
      )}
    </div>
  )
}
