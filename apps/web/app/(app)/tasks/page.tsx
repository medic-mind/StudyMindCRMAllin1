// Tasks page. CLAUDE.md §26 (URL state for shareable views, dense rows).
// Filters: scope (me / all), status. Sorted by due date ascending.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { dueAtLabel } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

import { NewTaskDialog } from './NewTaskDialog'
import { ReassignTaskButton } from './ReassignTaskButton'

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

const DUE_TONE_CLASS: Record<string, string> = {
  overdue: 'text-red-700 font-semibold',
  today: 'text-amber-700 font-semibold',
  soon: 'text-amber-700',
  later: 'text-neutral-600',
}

interface SP {
  scope?: 'me' | 'all'
  status?: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const scope: 'me' | 'all' = sp.scope === 'all' ? 'all' : 'me'
  const status = sp.status
  const caller = await createServerCaller()
  const data = await caller.task.list({ scope, limit: 100, status })
  const now = new Date()

  const tabs: Array<{ key: 'me' | 'all'; label: string }> = [
    { key: 'me', label: 'Assigned to me' },
    { key: 'all', label: 'Team' },
  ]
  const statusFilters: Array<{ key: SP['status']; label: string }> = [
    { key: undefined, label: 'All' },
    { key: 'open', label: 'Open' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'done', label: 'Done' },
  ]

  return (
    <>
      <PageHeader title="Tasks" actions={<NewTaskDialog />} />
      <PageBody>
        <div className="flex items-center gap-2 text-sm">
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={{
                pathname: '/tasks',
                query: { scope: t.key, ...(status ? { status } : {}) },
              }}
              className={
                scope === t.key
                  ? 'rounded bg-primary-700 px-2.5 py-1 text-white'
                  : 'rounded border border-neutral-200 px-2.5 py-1 text-neutral-700 hover:bg-neutral-100'
              }
            >
              {t.label}
            </Link>
          ))}
          <span className="mx-2 h-4 w-px bg-neutral-300" aria-hidden />
          {statusFilters.map((f) => {
            const active = status === f.key
            return (
              <Link
                key={f.label}
                href={{
                  pathname: '/tasks',
                  query: { scope, ...(f.key ? { status: f.key } : {}) },
                }}
                className={
                  active
                    ? 'rounded bg-neutral-100 px-2 py-1 text-neutral-900'
                    : 'rounded px-2 py-1 text-neutral-600 hover:bg-neutral-100'
                }
              >
                {f.label}
              </Link>
            )
          })}
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
          {data.items.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-medium text-neutral-700">
                {scope === 'me'
                  ? 'You have no tasks here yet.'
                  : 'No tasks for the team here.'}
              </p>
              <p className="mt-1 text-sm text-neutral-500">
                Create a task from a Contact or Family timeline to start
                tracking follow-ups.
              </p>
            </div>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Task</Th>
                  <Th>Status</Th>
                  <Th>Assignee</Th>
                  <Th>Due</Th>
                  <Th>Family</Th>
                  <Th>Actions</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.items.map((t) => {
                  const due = t.dueAt ? dueAtLabel(t.dueAt, now) : null
                  return (
                    <Tr key={t.id}>
                      <Td>
                        <span className="font-medium text-neutral-900">
                          {t.title}
                        </span>
                        {t.description ? (
                          <div className="truncate text-xs text-neutral-500">
                            {t.description}
                          </div>
                        ) : null}
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONE[t.status] ?? 'neutral'}>
                          {STATUS_LABEL[t.status] ?? t.status}
                        </Badge>
                      </Td>
                      <Td>
                        {t.assigneeEmail ? (
                          <span className="inline-flex items-center gap-2">
                            <Avatar name={t.assigneeName ?? t.assigneeEmail} size={22} />
                            <span className="truncate text-xs text-neutral-600">
                              {t.assigneeName ?? t.assigneeEmail}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-neutral-400">Unassigned</span>
                        )}
                      </Td>
                      <Td className="font-mono text-xs tabular-nums">
                        {due ? (
                          <span className={DUE_TONE_CLASS[due.tone] ?? ''}>
                            {due.label}
                          </span>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </Td>
                      <Td>
                        {t.familyId ? (
                          <Link
                            href={`/contacts/families/${t.familyId}`}
                            className="text-sm text-primary-700 hover:underline"
                          >
                            {t.familyName ?? 'Family'}
                          </Link>
                        ) : (
                          <span className="text-sm text-neutral-400">—</span>
                        )}
                      </Td>
                      <Td>
                        <ReassignTaskButton
                          taskId={t.id}
                          currentAssigneeId={t.assigneeId}
                        />
                      </Td>
                    </Tr>
                  )
                })}
              </Tbody>
            </Table>
          )}
        </div>
      </PageBody>
    </>
  )
}
