// Drag-and-drop kanban island (ADR 0019). Wraps every column in a single
// DndContext; each column is a SortableContext. Cards drag between and within
// columns. On drop we optimistically move the card in local state and call the
// audited `card.move` mutation with the target stageId + 1-based position;
// on error we revert and toast (CLAUDE.md §26 — never optimistic for money,
// but card position is safe).
//
// DnD is an enhancement only: each card keeps its keyboard-accessible
// "Move to…" dropdown and tick/cross quick actions (CLAUDE.md §28). A pointer
// activation distance keeps a click (open modal, PR #55) distinct from a drag,
// and the keyboard sensor lets non-mouse users reorder via the columns too.

'use client'

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useRouter } from 'next/navigation'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

import { BoardColumn } from './BoardColumn'

interface StageOption {
  id: string
  name: string
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
  subject: { id: string; name: string } | null
  labels: ReadonlyArray<LabelChip>
  lastActivityAt: string | Date | null
}
interface Stage {
  id: string
  name: string
  color: string
  isClosed: boolean
}

interface Props {
  stages: ReadonlyArray<Stage>
  cards: ReadonlyArray<CardData>
  stageOptions: ReadonlyArray<StageOption>
  tickStageId: string | null
  tickStageName: string | null
  xStageId: string | null
  xStageName: string | null
  canWrite: boolean
  canComment: boolean
  currentUserName: string
}

/** Resolve a drop target (a card id or a `stage:<id>` droppable) to a stage. */
function stageIdOfDroppable(
  overId: string,
  cards: ReadonlyArray<CardData>,
): string | null {
  if (overId.startsWith('stage:')) return overId.slice('stage:'.length)
  const card = cards.find((c) => c.id === overId)
  return card?.stageId ?? null
}

export function BoardDnd({
  stages,
  cards: initialCards,
  stageOptions,
  tickStageId,
  tickStageName,
  xStageId,
  xStageName,
  canWrite,
  canComment,
  currentUserName,
}: Props) {
  const router = useRouter()
  const [cards, setCards] = useState<CardData[]>(() => [...initialCards])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Snapshot of card state taken just before an optimistic move, so a failed
  // mutation can revert. A kanban only ever has one move in flight at a time.
  const preMoveSnapshot = useRef<CardData[] | null>(null)

  const sensors = useSensors(
    // 6px activation distance: a click (open modal) never starts a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const move = trpc.card.move.useMutation({
    onError: (e) => {
      if (preMoveSnapshot.current) setCards(preMoveSnapshot.current)
      preMoveSnapshot.current = null
      toast.error(e.message ?? 'Could not move card')
    },
    onSuccess: () => {
      preMoveSnapshot.current = null
      router.refresh()
    },
  })

  const byStage = useMemo(() => {
    const map = new Map<string, CardData[]>()
    for (const s of stages) map.set(s.id, [])
    for (const c of cards) map.get(c.stageId)?.push(c)
    return map
  }, [cards, stages])

  const activeCard = activeId ? cards.find((c) => c.id === activeId) ?? null : null

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id))
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const { active, over } = event
    if (!over) return
    const cardId = String(active.id)
    const overId = String(over.id)

    const moving = cards.find((c) => c.id === cardId)
    if (!moving) return

    const toStageId = stageIdOfDroppable(overId, cards)
    if (!toStageId) return

    // Compute the target index within the destination stage.
    const destCards = cards.filter((c) => c.stageId === toStageId && c.id !== cardId)
    let targetIndex = destCards.length
    if (!overId.startsWith('stage:')) {
      const idx = destCards.findIndex((c) => c.id === overId)
      if (idx >= 0) targetIndex = idx
    }

    // No-op if nothing changed (same stage, same slot).
    const fromIndex = cards
      .filter((c) => c.stageId === moving.stageId)
      .findIndex((c) => c.id === cardId)
    if (toStageId === moving.stageId && fromIndex === targetIndex) return

    preMoveSnapshot.current = cards.map((c) => ({ ...c }))

    // Optimistic reorder: rebuild the array with the card inserted at the slot.
    const remaining = cards.filter((c) => c.id !== cardId)
    const dest = remaining.filter((c) => c.stageId === toStageId)
    const elsewhere = remaining.filter((c) => c.stageId !== toStageId)
    const insertAt = Math.max(0, Math.min(targetIndex, dest.length))
    const reorderedDest = [
      ...dest.slice(0, insertAt),
      { ...moving, stageId: toStageId },
      ...dest.slice(insertAt),
    ]
    setCards([...elsewhere, ...reorderedDest])

    move.mutate({ cardId, toStageId, toPosition: insertAt + 1 })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {stages.map((stage) => (
          <BoardColumn
            key={stage.id}
            stage={stage}
            cards={byStage.get(stage.id) ?? []}
            stages={stageOptions}
            tickStageId={tickStageId}
            tickStageName={tickStageName}
            xStageId={xStageId}
            xStageName={xStageName}
            canWrite={canWrite}
            canComment={canComment}
            currentUserName={currentUserName}
          />
        ))}
      </div>
      <DragOverlay>
        {activeCard ? (
          <div className="rounded-md border border-primary-300 bg-white p-3 text-sm font-medium text-neutral-900 shadow-lg">
            {activeCard.contactName}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
