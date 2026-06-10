// Org-wide tasks list (slice B). Columns: assignee, title (links to detail),
// linked contact, due date (red if overdue), status. Filters via URL state:
// scope (Mine / Team / All), status, overdue. Default scope = All — everyone
// sees everything (product owner). CLAUDE.md §26.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { FacetedFilter } from '@/components/ui/faceted-filter'
import { ToggleFilter } from '@/components/ui/filter-bar'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { dueAtLabel, formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

import { NewTaskDialog } from './NewTaskDialog'
import { TaskCheckbox } from './TaskCheckbox'
import { TasksExportButton } from './TasksExportButton'

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
type View = 'live' | 'completed'
type StatusKey = 'open' | 'in_progress' | 'done'

interface SP {
  scope?: string
  view?: string
  status?: string
  overdue?: string
  teamId?: string
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const scope: Scope = sp.scope === 'mine' ? 'mine' : sp.scope === 'team' ? 'team' : 'all'
  // Live is the working default: completed tasks leave this list the moment
  // they're ticked and land in the Completed view instead.
  const view: View = sp.view === 'completed' ? 'completed' : 'live'
  const status = (
    sp.status === 'open' || sp.status === 'in_progress' || sp.status === 'done'
      ? sp.status
      : undefined
  ) as StatusKey | undefined
  const overdue = view === 'live' && sp.overdue === '1'
  const teamId = sp.teamId && sp.teamId.length > 0 ? sp.teamId : undefined

  const caller = await createServerCaller()
  const [data, teams] = await Promise.all([
    caller.task.list({
      scope: scope === 'mine' ? 'me' : scope === 'team' ? 'team' : 'all',
      teamId,
      view,
      // An explicit status pick only applies in the live view (the Completed
      // tab is already status-scoped to done/cancelled).
      status: view === 'live' ? status : undefined,
      overdue: overdue || undefined,
      limit: 100,
    }),
    caller.team.list({ includeArchived: false }),
  ])
  const now = new Date()

  const scopeTabs: Array<{ key: Scope; label: string }> = [
    { key: 'mine', label: 'My tasks' },
    { key: 'team', label: 'My teams' },
    { key: 'all', label: 'Everyone' },
  ]
  const viewTabs: Array<{ key: View; label: string }> = [
    { key: 'live', label: 'Live' },
    { key: 'completed', label: 'Completed' },
  ]

  // The segmented controls carry the other filters across a change (status /
  // team / overdue all live in the URL; the faceted filters own them).
  function buildQuery(next: { scope?: Scope; view?: View }) {
    const s = next.scope ?? scope
    const v = next.view ?? view
    const q: Record<string, string> = { scope: s }
    if (v === 'completed') q.view = 'completed'
    if (status && v === 'live') q.status = status
    if (overdue && v === 'live') q.overdue = '1'
    if (teamId) q.teamId = teamId
    return q
  }

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={`${data.items.length} task${data.items.length === 1 ? '' : 's'} in this view`}
        actions={
          <div className="flex items-center gap-2">
            <TasksExportButton
              scope={scope === 'mine' ? 'me' : scope === 'team' ? 'team' : 'all'}
              teamId={teamId}
              view={view}
              status={view === 'live' ? status : undefined}
              overdue={overdue || undefined}
            />
            <NewTaskDialog />
          </div>
        }
      />
      <PageBody>
        {/* View + scope segmented controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Task view"
            className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-card"
          >
            {viewTabs.map((t) => (
              <Link
                key={t.key}
                role="tab"
                aria-selected={view === t.key}
                href={{ pathname: '/tasks', query: buildQuery({ view: t.key }) }}
                className={
                  view === t.key
                    ? 'inline-flex items-center rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors'
                    : 'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
                }
              >
                {t.label}
              </Link>
            ))}
          </div>

          <div
            role="tablist"
            aria-label="Task scope"
            className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-card"
          >
            {scopeTabs.map((t) => (
              <Link
                key={t.key}
                role="tab"
                aria-selected={scope === t.key}
                href={{ pathname: '/tasks', query: buildQuery({ scope: t.key }) }}
                className={
                  scope === t.key
                    ? 'inline-flex items-center rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors'
                    : 'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
                }
              >
                {t.label}
              </Link>
            ))}
          </div>

          {/* Status filter — live view only (Completed is already done/cancelled). */}
          {view === 'live' ? (
            <FacetedFilter
              paramKey="status"
              label="Status"
              options={[
                { value: 'open', label: 'Open' },
                { value: 'in_progress', label: 'In progress' },
              ]}
            />
          ) : null}

          {/* Team filter */}
          {teams.length > 0 ? (
            <FacetedFilter
              paramKey="teamId"
              label="Team"
              options={teams.map((tm) => ({
                value: tm.id,
                label: tm.name,
                color: tm.color ?? undefined,
              }))}
            />
          ) : null}

          {/* Overdue toggle — meaningless for closed work. */}
          {view === 'live' ? (
            <ToggleFilter paramKey="overdue" label="Overdue only" tone="danger" />
          ) : null}
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
          {data.items.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-medium text-neutral-700">
                {view === 'completed'
                  ? 'Nothing completed in this view yet.'
                  : 'No live tasks match this filter.'}
              </p>
              <p className="mt-1 text-sm text-neutral-500">
                {view === 'completed'
                  ? 'Tick a task done and it moves here, out of the live list.'
                  : 'Create a task with the New task button, or from a contact’s timeline.'}
              </p>
            </div>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th className="w-8" aria-label="Done" />
                  <Th>Assignee</Th>
                  <Th>Task</Th>
                  <Th>Team</Th>
                  <Th>Contact</Th>
                  <Th>{view === 'completed' ? 'Completed' : 'Due'}</Th>
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
                        {t.teamName ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-neutral-700">
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: t.teamColor ?? '#94a3b8' }}
                            />
                            {t.teamName}
                          </span>
                        ) : (
                          <span className="text-xs text-neutral-400">—</span>
                        )}
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
                        {view === 'completed' ? (
                          <span
                            className="text-neutral-600"
                            title={new Intl.DateTimeFormat('en-GB', {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }).format(new Date(t.updatedAt))}
                          >
                            {formatRelativeTime(t.updatedAt, now)}
                          </span>
                        ) : due ? (
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
