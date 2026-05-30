// Client wrapper for a single board card. The whole card body (everything
// except the per-card controls) is clickable and opens the detail modal;
// quick-action buttons and the Move dropdown stay clickable on their own.
// ADR 0018, CLAUDE.md §26.
//
// Drag-and-drop (ADR 0019) is layered on by the SortableCard wrapper, which
// passes a `dragRef`, `dragStyle`, and `dragHandleProps`. When absent the
// card renders exactly as before, so the component is usable without DnD.

'use client'

import Link from 'next/link'
import { useState, type CSSProperties, type HTMLAttributes, type Ref } from 'react'

import { Badge } from '@/components/ui/badge'
import { formatRelativeTime } from '@/lib/format/relative-time'

import { resolveStageColor } from '../../pipeline/stage-color'
import { CardModal } from './CardModal'
import { MoveCardMenu } from './MoveCardMenu'
import { QuickActionButtons } from './QuickActionButtons'

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
interface QuickAction {
  id: string
  label: string
  color: string | null
  targetStageId: string
  targetStageName: string
  targetBoardName: string | null
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

interface Props {
  card: CardData
  stageId: string
  /** Column accent colour — used for the left-border so cards visually
   * inherit the stage they're in (one of the user's pain points: cards
   * look identical no matter which column they sit in). */
  stageColor?: string
  stages: ReadonlyArray<StageOption>
  crossBoardStages?: ReadonlyArray<CrossBoardGroup>
  quickActions: ReadonlyArray<QuickAction>
  canWrite: boolean
  canComment: boolean
  currentUserName: string
  // Supplied by SortableCard (ADR 0019); undefined when DnD is not in play.
  dragRef?: Ref<HTMLLIElement>
  dragStyle?: CSSProperties
  dragHandleProps?: HTMLAttributes<HTMLElement>
}

export function BoardCard({
  card,
  stageId,
  stageColor,
  stages,
  crossBoardStages = [],
  quickActions,
  canWrite,
  canComment,
  currentUserName,
  dragRef,
  dragStyle,
  dragHandleProps,
}: Props) {
  const [open, setOpen] = useState(false)
  const now = new Date()

  const borderColor = stageColor ? resolveStageColor(stageColor) : 'transparent'

  return (
    <li
      ref={dragRef}
      style={{ ...dragStyle, borderLeftColor: borderColor }}
      {...dragHandleProps}
      className={`group relative rounded-md border border-neutral-200 border-l-[3px] bg-white p-3 text-sm shadow-card transition-shadow hover:shadow-card-hover ${dragHandleProps ? 'touch-none' : ''}`}
    >
      {/* Whole-card click target. Sits behind the per-card controls so
       * those still receive their own clicks. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${card.contactName}`}
        className="absolute inset-0 z-0 cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
      />
      <div className="relative z-10 pointer-events-none">
        <div className="min-w-0 truncate font-medium text-neutral-900 group-hover:text-primary-700">
          {card.contactName}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {card.subject ? <Badge tone="info">{card.subject.name}</Badge> : null}
          {card.labels.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: resolveStageColor(l.color) }}
            >
              {l.name}
            </span>
          ))}
        </div>
        {card.lastActivityAt ? (
          <p className="mt-1.5 font-mono text-[10px] tabular-nums text-neutral-500">
            {formatRelativeTime(new Date(card.lastActivityAt), now)}
          </p>
        ) : null}
      </div>

      {/* Per-card interactive controls — sit on top of the click target. */}
      <div className="relative z-10 mt-2 space-y-2">
        <Link
          href={`/contacts/${card.contactId}`}
          className="inline-block text-[10px] text-neutral-500 hover:text-primary-700 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          Open contact →
        </Link>
        {canWrite && quickActions.length > 0 ? (
          <QuickActionButtons
            cardId={card.id}
            currentStageId={stageId}
            actions={quickActions}
          />
        ) : null}
        {canWrite ? (
          <div onClick={(e) => e.stopPropagation()}>
            <MoveCardMenu
              cardId={card.id}
              currentStageId={stageId}
              stages={stages}
              crossBoardStages={crossBoardStages}
            />
          </div>
        ) : null}
      </div>

      <CardModal
        cardId={card.id}
        open={open}
        onClose={() => setOpen(false)}
        stages={stages}
        crossBoardStages={crossBoardStages}
        quickActions={quickActions}
        canWrite={canWrite}
        canComment={canComment}
        currentUserName={currentUserName}
      />
    </li>
  )
}
