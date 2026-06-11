// A single board column: a droppable region wrapping a SortableContext of its
// cards (ADR 0019). Rendered by BoardDnd. The column header + empty state are
// preserved from the original RSC kanban so the visual stays identical.

'use client'

import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import type { CardFaceKey } from '@/lib/board/card-face'
import { Badge } from '@/components/ui/badge'

import { resolveStageColor } from '../../pipeline/stage-color'
import { AddCardButton } from './AddCardButton'
import { SortableCard } from './SortableCard'

interface StageOption {
  id: string
  name: string
}
interface LabelOption {
  id: string
  name: string
  color: string
}
interface CrossBoardGroup {
  boardId: string
  boardName: string
  stages: ReadonlyArray<StageOption>
}
interface LabelChip {
  id: string
  name: string
  color: string
}
interface CardData {
  id: string
  stageId: string
  contactId: string
  contactName: string
  contactEmail?: string | null
  contactPhone?: string | null
  company?: { id: string; name: string; color: string | null } | null
  description?: string | null
  subject: { id: string; name: string } | null
  /** Enquiry types from the contact's web enquiries ("Tutoring", "Summer
   * Camp", "Online Courses", …). */
  enquiryTypes?: ReadonlyArray<string>
  labels: ReadonlyArray<LabelChip>
  lastActivityAt: string | Date | null
  dueAt?: Date | string | null
  scheduledCallAt?: Date | string | null
  priority?: number | null
  assigneeId?: string | null
  assigneeName?: string | null
  assigneeEmail?: string | null
}
interface QuickAction {
  id: string
  label: string
  color: string | null
  targetStageId: string
  targetStageName: string
  targetBoardName: string | null
}

interface Props {
  boardId: string
  stage: { id: string; name: string; color: string; isClosed: boolean }
  cards: ReadonlyArray<CardData>
  stages: ReadonlyArray<StageOption>
  crossBoardStages?: ReadonlyArray<CrossBoardGroup>
  quickActions: ReadonlyArray<QuickAction>
  labels: ReadonlyArray<LabelOption>
  cardFields?: CardFaceKey[] | null
  canWrite: boolean
  canComment: boolean
  canDeleteCard: boolean
  currentUserName: string
  /** Optimistic local-state update so quick actions + move dropdown
   * shift the card immediately, before the server mutation lands. */
  onLocalMove?: (cardId: string, toStageId: string) => void
  /** Restores the pre-move snapshot when a server move is rejected. */
  onLocalRevert?: () => void
  /** Optimistic insert when a card is added from this column's footer. */
  onCardCreated?: (card: CardData) => void
}

export function BoardColumn({
  boardId,
  stage,
  cards,
  stages,
  crossBoardStages = [],
  quickActions,
  labels,
  cardFields,
  canWrite,
  canComment,
  canDeleteCard,
  currentUserName,
  onLocalMove,
  onLocalRevert,
  onCardCreated,
}: Props) {
  const colour = resolveStageColor(stage.color)
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${stage.id}` })

  return (
    <section
      ref={setNodeRef}
      className={`flex h-full flex-col overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50/40 shadow-card transition-shadow ${
        stage.isClosed ? 'opacity-80' : ''
      } ${isOver ? 'ring-2 ring-primary-300' : ''}`}
      style={{ borderTop: `3px solid ${colour}` }}
      aria-label={`${stage.name} column`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-neutral-100 bg-white px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: colour }}
            aria-hidden
          />
          <h2 className="truncate text-sm font-semibold text-neutral-800">{stage.name}</h2>
          {stage.isClosed ? <Badge tone="neutral">Closed</Badge> : null}
        </div>
        <span className="inline-flex min-w-[1.5rem] shrink-0 items-center justify-center rounded-full bg-neutral-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-neutral-600">
          {cards.length}
        </span>
      </header>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        {cards.length === 0 ? (
          <div className="flex-1 px-3 py-6 text-center text-xs text-neutral-400">
            No cards in {stage.name} yet.
          </div>
        ) : (
          <ul className="flex-1 space-y-2 p-2">
            {cards.map((c) => (
              <SortableCard
                key={c.id}
                card={c}
                stageId={stage.id}
                stageColor={stage.color}
                stages={stages}
                crossBoardStages={crossBoardStages}
                quickActions={quickActions}
                cardFields={cardFields}
                canWrite={canWrite}
                canComment={canComment}
                canDeleteCard={canDeleteCard}
                currentUserName={currentUserName}
                onLocalMove={onLocalMove}
                onLocalRevert={onLocalRevert}
              />
            ))}
          </ul>
        )}
      </SortableContext>
      {canWrite ? (
        <div className="border-t border-neutral-100 bg-white p-2">
          <AddCardButton
            boardId={boardId}
            stages={stages}
            labels={labels}
            defaultStageId={stage.id}
            onCreated={onCardCreated}
            variant="column"
          />
        </div>
      ) : null}
    </section>
  )
}
