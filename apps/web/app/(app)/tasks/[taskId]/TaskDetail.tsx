// Task detail client view (slice B). Status / assignee / due controls
// (sales_executive+) plus the shared CommentThread wired to task.comments.*.
// CLAUDE.md §26, §20.

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { CommentThread } from '@/components/thread/CommentThread'
import type { ThreadComment } from '@/components/thread/comment-types'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

import { TaskCheckbox } from '../TaskCheckbox'

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
}
const STATUS_TONE: Record<string, BadgeTone> = {
  open: 'info',
  in_progress: 'accent',
  blocked: 'warn',
  done: 'success',
  cancelled: 'neutral',
}
const STATUS_OPTIONS = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const

interface TaskData {
  id: string
  title: string
  description: string | null
  status: string
  assigneeId: string | null
  assigneeName: string | null
  contactId: string | null
  contactName: string | null
  familyId: string | null
  familyName: string | null
  dueAt: string | Date | null
  asanaTaskId: string | null
}

interface AssignableUser {
  id: string
  email: string
  name: string | null
}

interface Props {
  task: TaskData
  comments: ReadonlyArray<{
    id: string
    body: string
    authorId: string | null
    authorName: string | null
    occurredAt: string | Date
  }>
  assignableUsers: ReadonlyArray<AssignableUser>
  canWrite: boolean
  canComment: boolean
  currentUserName: string
}

function toDateInput(value: string | Date | null): string {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export function TaskDetail({
  task,
  comments,
  assignableUsers,
  canWrite,
  canComment,
  currentUserName,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [status, setStatus] = useState(task.status)
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? '')
  const [dueAt, setDueAt] = useState(toDateInput(task.dueAt))

  const update = trpc.task.update.useMutation({
    onSuccess: () => {
      toast.success('Task updated')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not update task'),
  })
  const addComment = trpc.task.comments.add.useMutation()

  const threadComments: ThreadComment[] = comments.map((c) => ({
    id: c.id,
    body: c.body,
    authorId: c.authorId,
    authorName: c.authorName,
    occurredAt: c.occurredAt,
  }))

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2">
            {canWrite ? <TaskCheckbox id={task.id} status={task.status} /> : null}
            <Badge tone={STATUS_TONE[task.status] ?? 'neutral'}>
              {STATUS_LABEL[task.status] ?? task.status}
            </Badge>
            {task.asanaTaskId ? <Badge tone="neutral">Asana-synced</Badge> : null}
          </div>
          {task.description ? (
            <p className="mt-3 whitespace-pre-wrap break-words text-sm text-neutral-700">
              {task.description}
            </p>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">No description.</p>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-neutral-900">Comments</h3>
          <CommentThread
            comments={threadComments}
            currentUserName={currentUserName}
            canComment={canComment}
            onAdd={async (body) => {
              await addComment.mutateAsync({ taskId: task.id, body })
              await utils.task.comments.list.invalidate({ taskId: task.id })
              router.refresh()
            }}
          />
        </section>
      </div>

      <aside className="space-y-4">
        <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-neutral-900">Details</h3>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs text-neutral-500">Linked contact</dt>
              <dd>
                {task.contactId ? (
                  <Link
                    href={`/contacts/${task.contactId}`}
                    className="text-primary-700 hover:underline"
                  >
                    {task.contactName ?? 'View contact'}
                  </Link>
                ) : task.familyId ? (
                  <Link
                    href={`/contacts/families/${task.familyId}`}
                    className="text-primary-700 hover:underline"
                  >
                    {task.familyName ?? 'Family'}
                  </Link>
                ) : (
                  <span className="text-neutral-400">None</span>
                )}
              </dd>
            </div>

            {canWrite ? (
              <>
                <label className="block">
                  <span className="text-xs text-neutral-500">Status</span>
                  <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">Assignee</span>
                  <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                    <option value="">Unassigned</option>
                    {assignableUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name ? `${u.name} (${u.email})` : u.email}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">Due</span>
                  <input
                    type="date"
                    value={dueAt}
                    onChange={(e) => setDueAt(e.target.value)}
                    className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      id: task.id,
                      status: status as (typeof STATUS_OPTIONS)[number],
                      assigneeId: assigneeId || null,
                      dueAt: dueAt ? new Date(dueAt) : null,
                    })
                  }
                >
                  {update.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </>
            ) : (
              <>
                <div>
                  <dt className="text-xs text-neutral-500">Assignee</dt>
                  <dd className="text-neutral-700">{task.assigneeName ?? 'Unassigned'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">Due</dt>
                  <dd className="text-neutral-700">
                    {task.dueAt ? new Date(task.dueAt).toLocaleDateString('en-GB') : '—'}
                  </dd>
                </div>
              </>
            )}
          </dl>
        </section>
      </aside>
    </div>
  )
}
