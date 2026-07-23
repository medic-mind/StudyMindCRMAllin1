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
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { CardFaceKey } from '@/lib/board/card-face'
import { filterCardsByQuery } from '@/lib/board/card-search'
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
} from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import { BoardColumn } from './BoardColumn'
import { BoardSearch } from './BoardSearch'

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
interface Stage {
  id: string
  name: string
  color: string
  isClosed: boolean
}

interface CrossBoardGroup {
  boardId: string
  boardName: string
  stages: ReadonlyArray<StageOption>
}
interface QuickAction {
  id: string
  label: string
  color: string | null
  targetStageId: string
  targetStageName: string
  targetBoardName: string | null
  isCheckbox: boolean
}

interface Props {
  boardId: string
  stages: ReadonlyArray<Stage>
  cards: ReadonlyArray<CardData>
  stageOptions: ReadonlyArray<StageOption>
  crossBoardStages?: ReadonlyArray<CrossBoardGroup>
  quickActions: ReadonlyArray<QuickAction>
  labels: ReadonlyArray<LabelChip>
  cardFields?: CardFaceKey[] | null
  canWrite: boolean
  canComment: boolean
  canDeleteCard: boolean
  currentUserName: string
}

/** Resolve a drop target (a card id or a `stage:<id>` droppable) to a stage. */
function stageIdOfDroppable(overId: string, cards: ReadonlyArray<CardData>): string | null {
  if (overId.startsWith('stage:')) return overId.slice('stage:'.length)
  const card = cards.find((c) => c.id === overId)
  return card?.stageId ?? null
}

export function BoardDnd({
  boardId,
  stages,
  cards: initialCards,
  stageOptions,
  crossBoardStages = [],
  quickActions,
  labels,
  cardFields,
  canWrite,
  canComment,
  canDeleteCard,
  currentUserName,
}: Props) {
  const [cards, setCards] = useState<CardData[]>(() => [...initialCards])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Snapshot of card state taken just before an optimistic move, so a failed
  // mutation can revert. A kanban only ever has one move in flight at a time.
  const preMoveSnapshot = useRef<CardData[] | null>(null)

  // Horizontal navigation. The columns row scrolls sideways within a bounded
  // height (below) so its scrollbar stays on-screen; these arrow buttons make
  // left/right movement obvious for mouse users (trackpad swipe / shift-wheel
  // already work). Buttons only show when the board actually overflows.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [overflowsX, setOverflowsX] = useState(false)
  const [overflowsY, setOverflowsY] = useState(false)
  const colScrollers = () =>
    Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>('[data-col-scroll]') ?? [],
    )
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = () => {
      setOverflowsX(el.scrollWidth > el.clientWidth + 4)
      // Vertical overflow is per-column now (each column's card list scrolls).
      // The rail shows when ANY column is taller than the view.
      setOverflowsY(colScrollers().some((c) => c.scrollHeight > c.clientHeight + 4))
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    // Card add/remove/move changes a column's height → re-check vertical overflow.
    const mo = new MutationObserver(check)
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [stages.length, cards.length])
  function scrollColumns(direction: -1 | 1) {
    // One column-width (≈ column + gap) per click.
    scrollRef.current?.scrollBy({ left: direction * 272, behavior: 'smooth' })
  }
  function scrollVertical(direction: -1 | 1) {
    // Each column scrolls its own cards (Todoist-style, headers stay put); the
    // rail scrolls every column in parallel so it reads as one board up/down.
    const cols = colScrollers()
    const step = Math.max(240, (scrollRef.current?.clientHeight ?? 480) * 0.8)
    for (const c of cols) c.scrollBy({ top: direction * step, behavior: 'smooth' })
  }

  // Reconcile server → local whenever the card set meaningfully changes. The
  // useState initialiser only runs once, so without this a `router.refresh()`
  // (after creating a card elsewhere, or any external change) would re-render
  // the RSC with fresh props that local state silently ignores — which is why
  // a newly-added card never showed up. We key off a content signature, not the
  // array reference (which is new every render), so optimistic moves aren't
  // clobbered: server props only change after a refresh, by which point they
  // already reflect the optimistic action.
  const serverSignature = useMemo(
    () =>
      initialCards
        .map((c) =>
          [
            c.id,
            c.stageId,
            c.contactName,
            c.contactEmail ?? '',
            c.contactPhone ?? '',
            c.description ?? '',
            c.priority ?? '',
            c.subject?.id ?? '',
            c.labels.map((l) => l.id).join(','),
            c.assigneeId ?? '',
            c.dueAt ? new Date(c.dueAt).getTime() : '',
            c.scheduledCallAt ? new Date(c.scheduledCallAt).getTime() : '',
            c.lastActivityAt ? new Date(c.lastActivityAt).getTime() : '',
          ].join(':'),
        )
        .join('|'),
    [initialCards],
  )
  const latestServerCards = useRef(initialCards)
  latestServerCards.current = initialCards
  useEffect(() => {
    setCards([...latestServerCards.current])
  }, [serverSignature])

  /** Optimistic local move — used by quick actions + the move dropdown
   * so the card jumps columns the instant the user clicks. The actual
   * server mutation lives inside the component that called us; we just
   * mutate local state here. A snapshot is taken first so the caller's
   * onError can revert via `revertLocalMove` — without it a rejected
   * move left the card stranded (or vanished) until a manual refresh. */
  function moveCardLocal(cardId: string, toStageId: string) {
    preMoveSnapshot.current = cards.map((c) => ({ ...c }))
    const onThisBoard = stages.some((s) => s.id === toStageId)
    if (onThisBoard) {
      setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, stageId: toStageId } : c)))
      // Bring the destination column into view so the card visibly lands
      // somewhere — "Call completed" style targets live off-screen to the
      // right and the move read as the card simply disappearing.
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-stage-col="${toStageId}"]`)
          ?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
      })
    } else {
      // Cross-board target: the card genuinely leaves this board. Remove it
      // locally (previously it was re-keyed onto a stage this board doesn't
      // render, which silently dropped it from every column with no revert).
      setCards((prev) => prev.filter((c) => c.id !== cardId))
    }
  }

  /** Restore the snapshot taken by the last optimistic move. Called by
   * quick actions / the move dropdown when their mutation fails. */
  function revertLocalMove() {
    if (preMoveSnapshot.current) {
      setCards(preMoveSnapshot.current)
      preMoveSnapshot.current = null
    }
  }

  /** Optimistic insert — a per-column (or toolbar) add drops the new card in
   * straight away. The subsequent router.refresh reconciles it with the
   * authoritative row (same id) via the signature effect above. */
  function addCardLocal(card: CardData) {
    setCards((prev) => [...prev.filter((c) => c.id !== card.id), card])
  }

  const sensors = useSensors(
    // 6px activation distance: a click (open modal) never starts a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const utils = trpc.useUtils()
  const move = trpc.card.move.useMutation({
    onError: (e) => {
      if (preMoveSnapshot.current) setCards(preMoveSnapshot.current)
      preMoveSnapshot.current = null
      toast.error(e.message ?? 'Could not move card')
    },
    onSuccess: async () => {
      preMoveSnapshot.current = null
      // The optimistic reorder already reflects the move; the row is persisted.
      // We deliberately do NOT router.refresh() — that reloaded the entire RSC
      // (all board queries + every card) on every drop, which is the flash/jank
      // users saw. Other surfaces catch up via this cheap query invalidation.
      await utils.card.list.invalidate()
    },
  })

  // Search filters the DISPLAYED cards only — the underlying `cards` state (and
  // every move/optimistic update) is untouched, so clearing the box restores
  // the full board instantly.
  const visibleCards = useMemo(() => filterCardsByQuery(cards, query), [cards, query])
  const byStage = useMemo(() => {
    const map = new Map<string, CardData[]>()
    for (const s of stages) map.set(s.id, [])
    for (const c of visibleCards) map.get(c.stageId)?.push(c)
    return map
  }, [visibleCards, stages])

  const activeCard = activeId ? (cards.find((c) => c.id === activeId) ?? null) : null

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
      <BoardSearch
        value={query}
        onChange={setQuery}
        matchCount={visibleCards.length}
        totalCount={cards.length}
      />
      {/* Horizontal scroll bar FIXED TO THE TOP of the board (columns → ←). */}
      {overflowsX ? (
        <HScrollBar position="top" onLeft={() => scrollColumns(-1)} onRight={() => scrollColumns(1)} />
      ) : null}

      <div className="relative">
        {/* Vertical up/down controls ALWAYS on the LEFT and RIGHT of the board
            (the operator ask). Shown whenever a column is taller than the view;
            they scroll the board up/down so you never hunt for the scrollbar. */}
        {overflowsY ? (
          <>
            <VScrollRail side="left" onUp={() => scrollVertical(-1)} onDown={() => scrollVertical(1)} />
            <VScrollRail side="right" onUp={() => scrollVertical(-1)} onDown={() => scrollVertical(1)} />
          </>
        ) : null}
        {/* Fixed-height board that fills the viewport: the row scrolls only
            HORIZONTALLY (columns), while each column scrolls its own cards
            vertically (Todoist-style — headers stay put, nothing is clipped).
            Denser columns + gap (zoomed out) so many more cards/columns show at
            once. Side padding leaves room for the vertical rails. */}
        <div
          ref={scrollRef}
          className="flex h-[calc(100dvh-16.5rem)] gap-3 overflow-x-auto overflow-y-hidden px-9 pb-2"
        >
          {stages.map((stage) => (
            <div
              key={stage.id}
              data-stage-col={stage.id}
              className="h-full min-w-[248px] max-w-[264px] flex-1"
            >
              <BoardColumn
                boardId={boardId}
                stage={stage}
                cards={byStage.get(stage.id) ?? []}
                stages={stageOptions}
                crossBoardStages={crossBoardStages}
                quickActions={quickActions}
                labels={labels}
                cardFields={cardFields}
                canWrite={canWrite}
                canComment={canComment}
                canDeleteCard={canDeleteCard}
                currentUserName={currentUserName}
                onLocalMove={moveCardLocal}
                onLocalRevert={revertLocalMove}
                onCardCreated={addCardLocal}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Horizontal scroll bar FIXED TO THE BOTTOM of the board. */}
      {overflowsX ? (
        <HScrollBar position="bottom" onLeft={() => scrollColumns(-1)} onRight={() => scrollColumns(1)} />
      ) : null}
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

/** Horizontal scroll control (columns left/right), fixed above or below the
 *  board so it is always reachable without hunting for the scrollbar. */
function HScrollBar({
  position,
  onLeft,
  onRight,
}: {
  position: 'top' | 'bottom'
  onLeft: () => void
  onRight: () => void
}) {
  const btn =
    'grid h-7 w-10 place-items-center rounded-md border border-neutral-200 bg-white text-neutral-600 shadow-sm transition-colors hover:bg-neutral-50 hover:text-neutral-900'
  return (
    <div className={`flex items-center justify-center gap-2 ${position === 'top' ? 'mb-1.5' : 'mt-1.5'}`}>
      <button type="button" aria-label="Scroll columns left" onClick={onLeft} className={btn}>
        <ChevronLeftIcon size={16} />
      </button>
      <span className="select-none text-[10px] font-medium uppercase tracking-wide text-neutral-400">
        Scroll columns
      </span>
      <button type="button" aria-label="Scroll columns right" onClick={onRight} className={btn}>
        <ChevronRightIcon size={16} />
      </button>
    </div>
  )
}

/** Vertical up/down control pinned to the left or right edge of the board, so
 *  scrolling a tall column is always one click away (the operator ask). */
function VScrollRail({
  side,
  onUp,
  onDown,
}: {
  side: 'left' | 'right'
  onUp: () => void
  onDown: () => void
}) {
  const btn =
    'grid h-9 w-9 place-items-center rounded-full border border-neutral-200 bg-white/95 text-neutral-600 shadow-md backdrop-blur transition-colors hover:bg-neutral-50 hover:text-neutral-900'
  return (
    <div
      className={`pointer-events-none absolute top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1.5 ${
        side === 'left' ? 'left-0' : 'right-0'
      }`}
    >
      <button
        type="button"
        aria-label="Scroll up"
        onClick={onUp}
        className={`pointer-events-auto ${btn}`}
      >
        <ChevronUpIcon size={18} />
      </button>
      <button
        type="button"
        aria-label="Scroll down"
        onClick={onDown}
        className={`pointer-events-auto ${btn}`}
      >
        <ChevronDownIcon size={18} />
      </button>
    </div>
  )
}
