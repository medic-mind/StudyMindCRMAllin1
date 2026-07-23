// Draggable wrapper around a single BoardCard (ADR 0019). Adds a drag handle
// region via @dnd-kit/sortable. Dragging is an enhancement only — the card's
// own "Move to…" dropdown and tick/cross quick actions remain keyboard
// accessible (CLAUDE.md §28). A small activation distance on the parent
// DndContext sensor keeps a click (which opens the modal, PR #55) distinct
// from a drag.

'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import type { CardFaceKey } from '@/lib/board/card-face'

import { BoardCard } from './BoardCard'

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
  company?: { id: string; name: string; color: string | null } | null
  description?: string | null
  subject: { id: string; name: string } | null
  /** Enquiry types from the contact's web enquiries ("Tutoring", "Summer
   * Camp", "Online Courses", …). */
  enquiryTypes?: ReadonlyArray<string>
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
  isCheckbox: boolean
}

interface Props {
  card: CardData
  stageId: string
  stageColor?: string
  stages: ReadonlyArray<StageOption>
  crossBoardStages?: ReadonlyArray<CrossBoardGroup>
  quickActions: ReadonlyArray<QuickAction>
  cardFields?: CardFaceKey[] | null
  canWrite: boolean
  canComment: boolean
  canDeleteCard: boolean
  currentUserName: string
  onLocalMove?: (cardId: string, toStageId: string) => void
  onLocalRevert?: () => void
}

export function SortableCard(props: Props) {
  // Only writers can drag; read-only roles render a plain card.
  const sortable = useSortable({ id: props.card.id, disabled: !props.canWrite })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  // We spread the drag listeners/attributes onto the list item so the whole
  // card is a drag source. BoardCard's own buttons stop propagation via the
  // activation-distance threshold; keyboard users use the dropdown fallback.
  return (
    <BoardCard
      {...props}
      dragRef={setNodeRef}
      dragStyle={style}
      dragHandleProps={props.canWrite ? { ...attributes, ...listeners } : undefined}
    />
  )
}
