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

const PRIORITY_CHIP_TONE: Record<number, string> = {
  1: 'bg-red-600 text-white',
  2: 'bg-orange-500 text-white',
  3: 'bg-amber-500 text-white',
  4: 'bg-neutral-400 text-white',
}

function initialsOf(name: string | null | undefined, email: string | null | undefined) {
  const s = (name ?? email ?? '?').trim()
  if (!s) return '?'
  const parts = s.split(/[\s@]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
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
  /** Optimistic move so quick actions + dropdown shift the card
   * instantly. Optional — when missing the card still moves via the
   * server round-trip + router.refresh, just not instantly. */
  onLocalMove?: (cardId: string, toStageId: string) => void
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
  onLocalMove,
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
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 truncate font-medium text-neutral-900 group-hover:text-primary-700">
            {card.contactName}
          </div>
          {card.priority != null && PRIORITY_CHIP_TONE[card.priority] && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold leading-none ${PRIORITY_CHIP_TONE[card.priority]}`}
              title={`Priority P${card.priority}`}
            >
              P{card.priority}
            </span>
          )}
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
        {/* Contact preview — phone + email so the agent can dial / mail
            without opening the card. */}
        {(card.contactEmail || card.contactPhone) && (
          <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-neutral-600">
            {card.contactPhone && (
              <span className="font-mono">{card.contactPhone}</span>
            )}
            {card.contactEmail && (
              <span className="truncate">{card.contactEmail}</span>
            )}
          </div>
        )}
        {/* Note preview — first 2 lines of the card description so the
            agent gets context at a glance. */}
        {card.description && card.description.trim().length > 0 && (
          <p className="mt-1 line-clamp-2 text-[11px] italic text-neutral-500">
            {card.description.trim()}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-neutral-500">
          {card.assigneeId && (
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary-100 text-[9px] font-semibold text-primary-800"
              title={card.assigneeName ?? card.assigneeEmail ?? 'Assigned'}
            >
              {initialsOf(card.assigneeName, card.assigneeEmail)}
            </span>
          )}
          {card.dueAt && (
            <span
              className={
                new Date(card.dueAt).getTime() < now.getTime()
                  ? 'font-semibold text-red-700'
                  : 'text-neutral-600'
              }
              title="Due date"
            >
              ⏱{' '}
              {new Intl.DateTimeFormat('en-GB', { dateStyle: 'short' }).format(
                new Date(card.dueAt),
              )}
            </span>
          )}
          {card.lastActivityAt ? (
            <span className="font-mono tabular-nums">
              {formatRelativeTime(new Date(card.lastActivityAt), now)}
            </span>
          ) : null}
        </div>
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
            onLocalMove={onLocalMove}
          />
        ) : null}
        {canWrite ? (
          <div onClick={(e) => e.stopPropagation()}>
            <MoveCardMenu
              cardId={card.id}
              currentStageId={stageId}
              stages={stages}
              crossBoardStages={crossBoardStages}
              onLocalMove={onLocalMove}
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
