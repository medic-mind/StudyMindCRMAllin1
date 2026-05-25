// Board kanban. ADR 0018. Columns are the board's PipelineStages; cards are
// grouped by stage. Each card shows the backing contact, its subject, and
// coloured label chips. No drag yet (slice 3) — a per-card "Move to…"
// dropdown handles transitions. CLAUDE.md §26, §20, §3.

import { notFound } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { getCurrentUser } from '@/lib/auth/server'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

import { resolveStageColor } from '../../pipeline/stage-color'
import { AddCardButton } from './AddCardButton'
import { BoardSwitcher } from './BoardSwitcher'
import { MoveCardMenu } from './MoveCardMenu'

export const dynamic = 'force-dynamic'

const CAN_WRITE = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])
const CAN_MANAGE = new Set(['ceo', 'senior_manager'])

interface PageProps {
  params: Promise<{ boardId: string }>
}

export default async function BoardPage({ params }: PageProps) {
  const { boardId } = await params
  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  const canWrite = CAN_WRITE.has(role)
  const canManage = CAN_MANAGE.has(role)

  const caller = await createServerCaller()

  let board
  try {
    board = await caller.board.get({ id: boardId })
  } catch {
    notFound()
  }

  const [boards, stages, cards, labels] = await Promise.all([
    caller.board.list(),
    caller.board.stages.list({ boardId }),
    caller.card.list({ boardId }),
    caller.label.list(),
  ])

  const stageOptions = stages.map((s) => ({ id: s.id, name: s.name }))
  const byStage = new Map<string, typeof cards>()
  for (const s of stages) byStage.set(s.id, [])
  for (const c of cards) {
    if (byStage.has(c.stageId)) byStage.get(c.stageId)!.push(c)
  }
  const now = new Date()

  return (
    <>
      <PageHeader
        title={board.name}
        subtitle={board.description ?? 'Cards grouped by stage. Every move is audited.'}
        breadcrumbs={[{ label: 'Boards', href: '/boards' }]}
        actions={
          <div className="flex items-center gap-2">
            <BoardSwitcher
              boards={boards.map((b) => ({ id: b.id, name: b.name }))}
              currentId={board.id}
            />
            {canManage ? (
              <a
                href={`/boards/${board.id}/settings`}
                className="inline-flex h-8 items-center rounded-md bg-neutral-100 px-3 text-sm font-medium text-neutral-800 hover:bg-neutral-200"
              >
                Settings
              </a>
            ) : null}
            {canWrite && stages.length > 0 ? (
              <AddCardButton
                boardId={board.id}
                stages={stageOptions}
                labels={labels}
              />
            ) : null}
          </div>
        }
      />
      <PageBody>
        {stages.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-600">
            This board has no stages yet.{' '}
            {canManage ? (
              <a href={`/boards/${board.id}/settings`} className="text-primary-700 underline">
                Add the first stage
              </a>
            ) : (
              'Ask an administrator to add a stage.'
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
            {stages.map((stage) => {
              const items = byStage.get(stage.id) ?? []
              const colour = resolveStageColor(stage.color)
              return (
                <section
                  key={stage.id}
                  className={`flex flex-col rounded-lg border border-neutral-200 bg-white shadow-sm ${
                    stage.isClosed ? 'opacity-80' : ''
                  }`}
                  style={{ borderTop: `3px solid ${colour}` }}
                >
                  <header className="flex items-center justify-between gap-2 border-b border-neutral-100 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: colour }}
                        aria-hidden
                      />
                      <h2 className="truncate text-sm font-semibold text-neutral-800">
                        {stage.name}
                      </h2>
                      {stage.isClosed ? <Badge tone="neutral">Closed</Badge> : null}
                    </div>
                    <Badge tone="neutral">{items.length}</Badge>
                  </header>
                  {items.length === 0 ? (
                    <div className="p-4 text-center text-xs text-neutral-500">
                      No cards in {stage.name}.
                    </div>
                  ) : (
                    <ul className="divide-y divide-neutral-100">
                      {items.map((c) => (
                        <li key={c.id} className="bg-white p-3 text-sm">
                          <a
                            href={`/contacts/${c.contactId}`}
                            className="block min-w-0 truncate font-medium text-neutral-900 hover:text-primary-700 hover:underline"
                          >
                            {c.contactName}
                          </a>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            {c.subject ? <Badge tone="info">{c.subject.name}</Badge> : null}
                            {c.labels.map((l) => (
                              <span
                                key={l.id}
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                                style={{ backgroundColor: resolveStageColor(l.color) }}
                              >
                                {l.name}
                              </span>
                            ))}
                          </div>
                          {c.lastActivityAt ? (
                            <p className="mt-1.5 font-mono text-[10px] tabular-nums text-neutral-500">
                              {formatRelativeTime(new Date(c.lastActivityAt), now)}
                            </p>
                          ) : null}
                          {canWrite ? (
                            <div className="mt-2">
                              <MoveCardMenu
                                cardId={c.id}
                                currentStageId={stage.id}
                                stages={stageOptions}
                              />
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </PageBody>
    </>
  )
}
