// Client wrapper for a single board card. The whole card body (everything
// except the per-card controls) is clickable and opens the detail modal;
// quick-action buttons and the Move dropdown stay clickable on their own.
// ADR 0018, CLAUDE.md §26.
//
// Drag-and-drop (ADR 0019) is layered on by the SortableCard wrapper, which
// passes a `dragRef`, `dragStyle`, and `dragHandleProps`. When absent the
// card renders exactly as before, so the component is usable without DnD.

'use client'

import { useState, type CSSProperties, type HTMLAttributes, type Ref } from 'react'

import { cardFaceHas, type CardFaceKey } from '@/lib/board/card-face'
import { Badge } from '@/components/ui/badge'
import { PhoneIcon } from '@/components/ui/icon'
import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { formatLondon } from '@/lib/format/london-time'
import { formatRelativeTime } from '@/lib/format/relative-time'
import {
  scheduleUrgency,
  URGENCY_CHIP_CLASS,
  URGENCY_LABEL,
} from '@/lib/format/schedule-urgency'

import { resolveStageColor } from '../../pipeline/stage-color'
import { CardCompleteCircle } from './CardCompleteCircle'
import { CardLabelQuickAdd } from './CardLabelQuickAdd'
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
  /** Render as a Todoist tick-circle on the card face instead of a chip. */
  isCheckbox: boolean
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
  /** Operator-configured card face (which preview fields show). undefined/null
   * means show all. */
  cardFields?: CardFaceKey[] | null
  canWrite: boolean
  canComment: boolean
  canDeleteCard: boolean
  currentUserName: string
  /** Optimistic move so quick actions + dropdown shift the card
   * instantly. Optional — when missing the card still moves via the
   * server round-trip + router.refresh, just not instantly. */
  onLocalMove?: (cardId: string, toStageId: string) => void
  /** Restores the pre-move snapshot when a server move is rejected. */
  onLocalRevert?: () => void
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
  cardFields,
  canWrite,
  canComment,
  canDeleteCard,
  currentUserName,
  onLocalMove,
  onLocalRevert,
  dragRef,
  dragStyle,
  dragHandleProps,
}: Props) {
  const [open, setOpen] = useState(false)
  const now = new Date()

  const borderColor = stageColor ? resolveStageColor(stageColor) : 'transparent'

  // The board's designated tick-circle action (seeded as "Call completed")
  // ALSO renders as a Todoist-style circle by the card name — but it stays in
  // the chip row too (operator ask: keep both "Call completed" the chip AND the
  // tick-circle, even though they do the same thing). Hide only the circle once
  // the card already sits on that action's target stage.
  const checkboxAction = quickActions.find((a) => a.isCheckbox)
  const showCircle =
    canWrite && checkboxAction != null && checkboxAction.targetStageId !== stageId
  const chipActions = quickActions

  return (
    <li
      ref={dragRef}
      style={{ ...dragStyle, borderLeftColor: borderColor }}
      {...dragHandleProps}
      className={`group relative rounded-lg border border-neutral-200 border-l-[3px] bg-white p-2.5 text-sm shadow-card transition-shadow hover:shadow-card-hover ${dragHandleProps ? 'touch-none' : ''}`}
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
          <div className="flex min-w-0 items-start gap-2">
            {showCircle && checkboxAction ? (
              <CardCompleteCircle
                cardId={card.id}
                action={checkboxAction}
                onLocalMove={onLocalMove}
                onLocalRevert={onLocalRevert}
              />
            ) : null}
            <div className="min-w-0 truncate text-[13px] font-semibold text-neutral-900 group-hover:text-primary-700">
              {card.contactName}
            </div>
          </div>
          {cardFaceHas(cardFields, 'priority') &&
            card.priority != null &&
            PRIORITY_CHIP_TONE[card.priority] && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold leading-none ${PRIORITY_CHIP_TONE[card.priority]}`}
                title={`Priority P${card.priority}`}
              >
                P{card.priority}
              </span>
            )}
        </div>
        {/* Contact preview directly under the name (NAME → email → phone) —
            clickable to mail / dial without opening the card.
            `pointer-events-auto` re-enables clicks inside the otherwise
            click-through card body; the links stopPropagation so they don't
            also open the modal. */}
        {cardFaceHas(cardFields, 'contact') && (card.contactEmail || card.contactPhone) && (
          <div className="pointer-events-auto mt-1.5 flex flex-col gap-1 text-xs text-neutral-600">
            {card.contactEmail && <EmailLink email={card.contactEmail} />}
            {card.contactPhone && (
              <PhoneLink phone={card.contactPhone} contactId={card.contactId} />
            )}
          </div>
        )}
        {/* SUBJECT — COMPANY — enquiry-type row, then any labels. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {cardFaceHas(cardFields, 'subject') && card.subject ? (
            <Badge tone="info">{card.subject.name}</Badge>
          ) : null}
          {cardFaceHas(cardFields, 'company') && card.company ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium text-neutral-700"
              title="Company"
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: resolveStageColor(card.company.color ?? 'neutral-400') }}
              />
              {card.company.name}
            </span>
          ) : null}
          {cardFaceHas(cardFields, 'enquiryType') &&
            (card.enquiryTypes ?? [])
              .filter((t) => t !== card.subject?.name)
              .slice(0, 3)
              .map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 ring-1 ring-inset ring-neutral-200"
                  title="What they enquired about"
                >
                  {t}
                </span>
              ))}
          {cardFaceHas(cardFields, 'labels') &&
            card.labels.map((l) => (
              <span
                key={l.id}
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                style={{ backgroundColor: resolveStageColor(l.color) }}
              >
                {l.name}
              </span>
            ))}
          {/* Quick-add a label without opening the card (ops request). Lives in
              the click-through body, so it re-enables pointer events + stops
              propagation itself. */}
          {canWrite && cardFaceHas(cardFields, 'labels') ? (
            <CardLabelQuickAdd
              cardId={card.id}
              currentLabelIds={card.labels.map((l) => l.id)}
            />
          ) : null}
        </div>
        {/* Note preview — first 2 lines of the card description so the
            agent gets context at a glance. */}
        {cardFaceHas(cardFields, 'description') &&
          card.description &&
          card.description.trim().length > 0 && (
            <p className="mt-2 line-clamp-2 text-xs leading-snug text-neutral-600">
              {card.description.trim()}
            </p>
          )}
        {/* Scheduled call is the headline metadata on these boards — give it
            its own row at a readable size (was lost in the meta strip
            previously). Past times go red; future times stay primary. */}
        {cardFaceHas(cardFields, 'scheduledCall') && card.scheduledCallAt
          ? (() => {
              // Todoist-style urgency colour so it's obvious which calls need
              // doing: overdue red · today orange · tomorrow amber · this week
              // blue · later neutral.
              const urgency = scheduleUrgency(new Date(card.scheduledCallAt), now)
              const label = URGENCY_LABEL[urgency]
              return (
                <div className="mt-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${URGENCY_CHIP_CLASS[urgency]}`}
                    title="Scheduled call (UK time)"
                  >
                    <PhoneIcon size={11} />
                    {label ? `${label} · ` : ''}
                    {formatLondon(card.scheduledCallAt, {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              )
            })()
          : null}
        {/* Tertiary meta — assignee + due + last activity. Small, even
            spacing, no emoji so the row is uniform. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-neutral-500">
          {cardFaceHas(cardFields, 'assignee') && card.assigneeId && (
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary-100 text-[9px] font-semibold text-primary-800"
              title={card.assigneeName ?? card.assigneeEmail ?? 'Assigned'}
            >
              {initialsOf(card.assigneeName, card.assigneeEmail)}
            </span>
          )}
          {cardFaceHas(cardFields, 'dueDate') && card.dueAt && (
            <span
              className={
                new Date(card.dueAt).getTime() < now.getTime()
                  ? 'inline-flex items-center gap-1 font-semibold text-red-700'
                  : 'inline-flex items-center gap-1 text-neutral-600'
              }
              title="Due date"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
              {new Intl.DateTimeFormat('en-GB', { dateStyle: 'short' }).format(
                new Date(card.dueAt),
              )}
            </span>
          )}
          {cardFaceHas(cardFields, 'lastActivity') && card.lastActivityAt ? (
            <span className="font-mono tabular-nums">
              {formatRelativeTime(new Date(card.lastActivityAt), now)}
            </span>
          ) : null}
        </div>
      </div>

      {/* Per-card interactive controls — sit on top of the click target.
          Dropped the "Open contact →" link; the contact name (which is the
          card's headline) already routes via the card modal and competes
          less for attention. The Quick actions + Move-to are the only
          per-card affordances left, separated from the card body by a
          hairline so they read as "controls" rather than "more info". */}
      <div className="relative z-10 mt-2.5 space-y-1.5 border-t border-neutral-100 pt-2">
        {canWrite && chipActions.length > 0 ? (
          <QuickActionButtons
            cardId={card.id}
            currentStageId={stageId}
            actions={chipActions}
            onLocalMove={onLocalMove}
            onLocalRevert={onLocalRevert}
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
              onLocalRevert={onLocalRevert}
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
        canDeleteCard={canDeleteCard}
        currentUserName={currentUserName}
      />
    </li>
  )
}
