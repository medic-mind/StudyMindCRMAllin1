// Board kanban. ADR 0018 + ADR 0019 (drag-and-drop). Columns are the board's
// PipelineStages; cards are grouped by stage. The interactive column grid is a
// client island (BoardDnd) so cards can be dragged between/within columns; the
// per-card "Move to…" dropdown + tick/cross quick actions remain as
// keyboard-accessible fallbacks (CLAUDE.md §26, §28, §20, §3).

import { notFound } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { AddCardButton } from './AddCardButton'
import { BoardDnd } from './BoardDnd'
import { BoardSwitcher } from './BoardSwitcher'

export const dynamic = 'force-dynamic'

const CAN_WRITE = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])
const CAN_MANAGE = new Set(['ceo', 'senior_manager'])
// Hard-deleting a card is Manager+ (CARD_DELETE_ROLES in the tRPC router).
const CAN_DELETE_CARD = new Set(['ceo', 'senior_manager', 'manager'])

interface PageProps {
  params: Promise<{ boardId: string }>
}

export default async function BoardPage({ params }: PageProps) {
  const { boardId } = await params
  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  const canWrite = CAN_WRITE.has(role)
  const canManage = CAN_MANAGE.has(role)
  const canDeleteCard = CAN_DELETE_CARD.has(role)
  // Any authenticated user may comment (incl. virtual_assistant); the server
  // gates card.comments.add the same way.
  const canComment = Boolean(me)
  const currentUserName = me?.name?.trim() || me?.email || 'You'

  const caller = await createServerCaller()

  let board
  try {
    board = await caller.board.get({ id: boardId })
  } catch {
    notFound()
  }

  const [boards, stages, cards, labels, quickActions] = await Promise.all([
    caller.board.list(),
    caller.board.stages.list({ boardId }),
    caller.card.list({ boardId }),
    caller.label.list(),
    caller.card.quickActions.list({ boardId, includeArchived: false }),
  ])

  // For cross-board move support: load the stages for every other board so
  // MoveCardMenu can offer "Move to other board → stage" in a nested optgroup.
  const otherBoards = boards.filter((b) => b.id !== boardId)
  const otherBoardStages = await Promise.all(
    otherBoards.map(async (b) => ({
      boardId: b.id,
      boardName: b.name,
      stages: (await caller.board.stages.list({ boardId: b.id })).map((s) => ({
        id: s.id,
        name: s.name,
      })),
    })),
  )

  const stageOptions = stages.map((s) => ({ id: s.id, name: s.name }))

  const dndCards = cards.map((c) => ({
    id: c.id,
    stageId: c.stageId,
    contactId: c.contactId,
    contactName: c.contactName,
    contactEmail: c.contactEmail,
    contactPhone: c.contactPhone,
    description: c.description,
    subject: c.subject,
    labels: c.labels,
    lastActivityAt: c.lastActivityAt,
    dueAt: c.dueAt,
    scheduledCallAt: c.scheduledCallAt,
    priority: c.priority,
    assigneeId: c.assigneeId,
    assigneeName: c.assigneeName,
    assigneeEmail: c.assigneeEmail,
  }))
  const dndStages = stages.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    isClosed: s.isClosed,
  }))

  return (
    <>
      <PageHeader
        title={board.name}
        subtitle={board.description ?? 'Cards grouped by stage. Every move is audited.'}
        breadcrumbs={[{ label: 'Boards', href: '/boards' }]}
      />
      {/* Sticky board toolbar — board picker on the left, Settings + Add card
          on the right, anchored to the top of the viewport so the agent can
          switch board or drop a new card from anywhere on the page
          regardless of horizontal scroll on the kanban. */}
      <div className="sticky top-0 z-30 -mx-6 mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200/80 bg-white/95 px-6 py-2 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
            Board
          </span>
          <BoardSwitcher
            boards={boards.map((b) => ({ id: b.id, name: b.name }))}
            currentId={board.id}
          />
        </div>
        <div className="flex items-center gap-2">
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
      </div>
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
          <BoardDnd
            stages={dndStages}
            cards={dndCards}
            stageOptions={stageOptions}
            crossBoardStages={otherBoardStages}
            quickActions={quickActions}
            canWrite={canWrite}
            canComment={canComment}
            canDeleteCard={canDeleteCard}
            currentUserName={currentUserName}
          />
        )}
      </PageBody>
    </>
  )
}
