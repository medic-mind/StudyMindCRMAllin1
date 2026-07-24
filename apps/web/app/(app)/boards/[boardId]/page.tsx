// Board kanban. ADR 0018 + ADR 0019 (drag-and-drop). Columns are the board's
// PipelineStages; cards are grouped by stage. The interactive column grid is a
// client island (BoardDnd) so cards can be dragged between/within columns; the
// per-card "Move to…" dropdown + tick/cross quick actions remain as
// keyboard-accessible fallbacks (CLAUDE.md §26, §28, §20, §3).

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { SettingsIcon } from '@/components/ui/icon'
import { getCurrentUser } from '@/lib/auth/server'
import { parseCardFace } from '@/lib/board/card-face'
import { createServerCaller } from '@/lib/trpc/server'

import { AddCardButton } from './AddCardButton'
import { BoardDnd } from './BoardDnd'
import { ClearBoardButton } from './ClearBoardButton'
import { BoardListView } from './BoardListView'
import { BoardSwitcher } from './BoardSwitcher'
import { BoardViewToggle } from './BoardViewToggle'

export const dynamic = 'force-dynamic'

// Every staff role can add / move / action cards — the same set the tRPC
// router's CARD_WRITE_ROLES allows. Virtual Assistant was missing here, so the
// UI hid Add-card / move / quick-actions from them even though the server would
// have accepted it (§20 — VA ≡ Sales Executive since 2026-07).
const CAN_WRITE = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])
// Board management + hard-deleting a card are open to every staff role
// (2026-07 — VA and above can do anything operational). The board tRPC router
// (BOARD_MANAGE_ROLES / CARD_DELETE_ROLES) gates + audits each write. Clearing
// a whole board stays CEO-only (see the `role === 'ceo'` guard below).
const CAN_MANAGE = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])
const CAN_DELETE_CARD = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

interface PageProps {
  params: Promise<{ boardId: string }>
  searchParams: Promise<{ view?: string }>
}

export default async function BoardPage({ params, searchParams }: PageProps) {
  const { boardId } = await params
  const { view: viewParam } = await searchParams
  const view: 'kanban' | 'list' = viewParam === 'list' ? 'list' : 'kanban'
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
    company: c.company,
    description: c.description,
    subject: c.subject,
    enquiryTypes: c.enquiryTypes,
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
      {/* Sticky board toolbar — switcher, Add card, and Settings are grouped
          together on the left (next to where the agent's attention already is)
          rather than split to opposite edges, and stay anchored to the top of
          the viewport so they're reachable regardless of horizontal scroll on
          the kanban. */}
      <div className="sticky top-0 z-30 -mx-6 mb-4 flex flex-wrap items-center gap-3 border-b border-neutral-200/80 bg-white/95 px-6 py-2 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        {boards.length > 1 ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
                Board
              </span>
              <BoardSwitcher
                boards={boards.map((b) => ({ id: b.id, name: b.name }))}
                currentId={board.id}
              />
            </div>
            <div className="h-5 w-px bg-neutral-200" aria-hidden />
          </>
        ) : null}
        {canWrite && stages.length > 0 ? (
          <AddCardButton boardId={board.id} stages={stageOptions} labels={labels} />
        ) : null}
        {canManage ? (
          <Link
            href={`/boards/${board.id}/settings`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-100 px-3 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-200"
          >
            <SettingsIcon size={15} className="text-neutral-500" />
            Settings
          </Link>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {/* Clearing a whole board is CEO-only (operator direction) and is
              double-verified with a puzzle in the button below. */}
          {role === 'ceo' ? (
            <ClearBoardButton
              boardId={board.id}
              boardName={board.name}
              cardCount={cards.length}
            />
          ) : null}
          <BoardViewToggle view={view} />
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
        ) : view === 'list' ? (
          <BoardListView
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
        ) : (
          <BoardDnd
            boardId={board.id}
            stages={dndStages}
            cards={dndCards}
            stageOptions={stageOptions}
            crossBoardStages={otherBoardStages}
            quickActions={quickActions}
            labels={labels}
            cardFields={parseCardFace(board.cardFields)}
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
