// A single board column: a droppable region wrapping a SortableContext of its
// cards (ADR 0019). Rendered by BoardDnd. The column header + empty state are
// preserved from the original RSC kanban so the visual stays identical.

'use client'

import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { Badge } from '@/components/ui/badge'

import { resolveStageColor } from '../../pipeline/stage-color'
import { SortableCard } from './SortableCard'

interface StageOption {
  id: string
  name: string
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
  description?: string | null
  subject: { id: string; name: string } | null
  labels: ReadonlyArray<LabelChip>
  lastActivityAt: string | Date | null
  dueAt?: Date | string | null
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
  stage: { id: string; name: string; color: string; isClosed: boolean }
  cards: ReadonlyArray<CardData>
  stages: ReadonlyArray<StageOption>
  crossBoardStages?: ReadonlyArray<CrossBoardGroup>
  quickActions: ReadonlyArray<QuickAction>
  canWrite: boolean
  canComment: boolean
  currentUserName: string
  /** Optimistic local-state update so quick actions + move dropdown
   * shift the card immediately, before the server mutation lands. */
  onLocalMove?: (cardId: string, toStageId: string) => void
}

export function BoardColumn({
  stage,
  cards,
  stages,
  crossBoardStages = [],
  quickActions,
  canWrite,
  canComment,
  currentUserName,
  onLocalMove,
}: Props) {
  const colour = resolveStageColor(stage.color)
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${stage.id}` })

  return (
    <section
      ref={setNodeRef}
      className={`flex flex-col rounded-lg border border-neutral-200 bg-white shadow-card ${
        stage.isClosed ? 'opacity-80' : ''
      } ${isOver ? 'ring-2 ring-primary-300' : ''}`}
      style={{ borderTop: `3px solid ${colour}` }}
      aria-label={`${stage.name} column`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-neutral-100 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ backgroundColor: colour }}
            aria-hidden
          />
          <h2 className="truncate text-sm font-semibold text-neutral-800">{stage.name}</h2>
          {stage.isClosed ? <Badge tone="neutral">Closed</Badge> : null}
        </div>
        <Badge tone="neutral">{cards.length}</Badge>
      </header>
      <SortableContext
        items={cards.map((c) => c.id)}
        strategy={verticalListSortingStrategy}
      >
        {cards.length === 0 ? (
          <div className="p-4 text-center text-xs text-neutral-500">
            No cards in {stage.name}.
          </div>
        ) : (
          <ul className="space-y-2 p-2">
            {cards.map((c) => (
              <SortableCard
                key={c.id}
                card={c}
                stageId={stage.id}
                stageColor={stage.color}
                stages={stages}
                crossBoardStages={crossBoardStages}
                quickActions={quickActions}
                canWrite={canWrite}
                canComment={canComment}
                currentUserName={currentUserName}
                onLocalMove={onLocalMove}
              />
            ))}
          </ul>
        )}
      </SortableContext>
    </section>
  )
}
