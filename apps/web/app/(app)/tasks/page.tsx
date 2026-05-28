// Org-wide tasks list (slice B). Columns: assignee, title (links to detail),
// linked contact, due date (red if overdue), status. Filters via URL state:
// scope (Mine / Team / All), status, overdue. Default scope = All — everyone
// sees everything (product owner). CLAUDE.md §26.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { dueAtLabel } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

import { NewTaskDialog } from './NewTaskDialog'
import { TaskCheckbox } from './TaskCheckbox'

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

type Scope = 'mine' | 'team' | 'all'
type StatusKey = 'open' | 'in_progress' | 'done'

interface SP {
  scope?: string
  status?: string
  overdue?: string
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const scope: Scope = sp.scope === 'mine' ? 'mine' : sp.scope === 'team' ? 'team' : 'all'
  const status = (
    sp.status === 'open' || sp.status === 'in_progress' || sp.status === 'done'
      ? sp.status
      : undefined
  ) as StatusKey | undefined
  const overdue = sp.overdue === '1'

  const caller = await createServerCaller()
  // "Mine" filters to the caller; "Team" and "All" both show every task in this
  // single-team CRM (the router scope is me | all).
  const data = await caller.task.list({
    scope: scope === 'mine' ? 'me' : 'all',
    status,
    overdue: overdue || undefined,
    limit: 100,
  })
  const now = new Date()

  const scopeTabs: Array<{ key: Scope; label: string }> = [
    { key: 'mine', label: 'Mine' },
    { key: 'team', label: 'Team' },
    { key: 'all', label: 'All' },
  ]
  const statusFilters: Array<{ key: StatusKey | undefined; label: string }> = [
    { key: undefined, label: 'All statuses' },
    { key: 'open', label: 'Open' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'done', label: 'Done' },
  ]

  function buildQuery(next: {
    scope?: Scope
    status?: StatusKey | undefined
    setStatus?: boolean
    overdue?: boolean
  }) {
    const nextStatus = next.setStatus ? next.status : status
    const q: Record<string, string> = { scope: next.scope ?? scope }
    if (nextStatus) q.status = nextStatus
    if (next.overdue ?? overdue) q.overdue = '1'
    return q
  }

  return (
    <>
      <PageHeader title="Tasks" actions={<NewTaskDialog />} />
      <PageBody>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {scopeTabs.map((t) => (
            <Link
              key={t.key}
              href={{ pathname: '/tasks', query: buildQuery({ scope: t.key }) }}
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
                href={{ pathname: '/tasks', query: buildQuery({ status: f.key, setStatus: true }) }}
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
          <span className="mx-2 h-4 w-px bg-neutral-300" aria-hidden />
          <Link
            href={{ pathname: '/tasks', query: buildQuery({ overdue: !overdue }) }}
            className={
              overdue
                ? 'rounded bg-red-700 px-2.5 py-1 text-white'
                : 'rounded border border-neutral-200 px-2.5 py-1 text-neutral-700 hover:bg-neutral-100'
            }
          >
            Overdue only
          </Link>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
          {data.items.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-medium text-neutral-700">No tasks match this filter.</p>
              <p className="mt-1 text-sm text-neutral-500">
                Create a task with the New task button, or from a contact&apos;s timeline.
              </p>
            </div>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th className="w-8" aria-label="Done" />
                  <Th>Assignee</Th>
                  <Th>Task</Th>
                  <Th>Contact</Th>
                  <Th>Due</Th>
                  <Th>Status</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.items.map((t) => {
                  const due = t.dueAt ? dueAtLabel(t.dueAt, now) : null
                  const isDone = t.status === 'done' || t.status === 'cancelled'
                  return (
                    <Tr key={t.id}>
                      <Td className="pr-0">
                        <TaskCheckbox id={t.id} status={t.status} />
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
                      <Td>
                        <Link
                          href={`/tasks/${t.id}`}
                          className={`font-medium hover:text-primary-700 hover:underline ${
                            isDone
                              ? 'text-neutral-400 line-through'
                              : 'text-neutral-900'
                          }`}
                        >
                          {t.title}
                        </Link>
                        {t.description ? (
                          <div className="truncate text-xs text-neutral-500">{t.description}</div>
                        ) : null}
                      </Td>
                      <Td>
                        {t.contactId ? (
                          <Link
                            href={`/contacts/${t.contactId}`}
                            className="text-sm text-primary-700 hover:underline"
                          >
                            View contact
                          </Link>
                        ) : t.familyId ? (
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
                      <Td className="font-mono text-xs tabular-nums">
                        {due ? (
                          <span className={DUE_TONE_CLASS[due.tone] ?? ''}>{due.label}</span>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONE[t.status] ?? 'neutral'} dot>
                          {STATUS_LABEL[t.status] ?? t.status}
                        </Badge>
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
