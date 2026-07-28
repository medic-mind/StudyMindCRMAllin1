// List view for a board (alternative to the kanban). Same cards + stages,
// rendered as compact tables grouped by stage instead of columns. A row click
// opens the same CardModal; per-row Move + quick actions reuse the kanban's
// components, so the two views stay behaviourally identical. Selected via
// `?view=list` on the board page (BoardViewToggle). CLAUDE.md §26, §28, §3.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { PhoneIcon } from '@/components/ui/icon'
import { filterCardsByQuery } from '@/lib/board/card-search'
import { formatLondon } from '@/lib/format/london-time'
import { formatRelativeTime } from '@/lib/format/relative-time'

import { resolveStageColor } from '../../pipeline/stage-color'
import { BoardSearch } from './BoardSearch'
import { CardModal } from './CardModal'
import { MoveCardMenu } from './MoveCardMenu'
import { QuickActionButtons } from './QuickActionButtons'

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
  stages: ReadonlyArray<Stage>
  cards: ReadonlyArray<CardData>
  stageOptions: ReadonlyArray<StageOption>
  crossBoardStages?: ReadonlyArray<CrossBoardGroup>
  quickActions: ReadonlyArray<QuickAction>
  canWrite: boolean
  canComment: boolean
  canDeleteCard: boolean
  currentUserName: string
}

function initialsOf(name: string | null | undefined, email: string | null | undefined) {
  const s = (name ?? email ?? '?').trim()
  if (!s) return '?'
  const parts = s.split(/[\s@]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function BoardListView({
  stages,
  cards: initialCards,
  stageOptions,
  crossBoardStages = [],
  quickActions,
  canWrite,
  canComment,
  canDeleteCard,
  currentUserName,
}: Props) {
  const [cards, setCards] = useState<CardData[]>(() => [...initialCards])
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  // Reconcile server → local on any meaningful change (mirrors BoardDnd) so a
  // move/refresh elsewhere is reflected without clobbering optimistic moves.
  const serverSignature = useMemo(
    () =>
      initialCards
        .map((c) =>
          [
            c.id,
            c.stageId,
            c.contactName,
            c.assigneeId ?? '',
            c.dueAt ? new Date(c.dueAt).getTime() : '',
            c.scheduledCallAt ? new Date(c.scheduledCallAt).getTime() : '',
            c.lastActivityAt ? new Date(c.lastActivityAt).getTime() : '',
            c.labels.map((l) => l.id).join(','),
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

  // Snapshot before each optimistic move so a rejected server mutation can
  // revert (mirrors BoardDnd). Cross-board targets remove the card locally —
  // re-keying it onto a stage this board doesn't render silently dropped it.
  const preMoveSnapshot = useRef<CardData[] | null>(null)
  function moveCardLocal(cardId: string, toStageId: string) {
    preMoveSnapshot.current = cards.map((c) => ({ ...c }))
    const onThisBoard = stages.some((st) => st.id === toStageId)
    setCards((prev) =>
      onThisBoard
        ? prev.map((c) => (c.id === cardId ? { ...c, stageId: toStageId } : c))
        : prev.filter((c) => c.id !== cardId),
    )
  }
  function revertLocalMove() {
    if (preMoveSnapshot.current) {
      setCards(preMoveSnapshot.current)
      preMoveSnapshot.current = null
    }
  }

  // Search filters only what's shown; `cards` (and moves) are untouched.
  const visibleCards = useMemo(() => filterCardsByQuery(cards, query), [cards, query])
  const byStage = useMemo(() => {
    const map = new Map<string, CardData[]>()
    for (const s of stages) map.set(s.id, [])
    for (const c of visibleCards) map.get(c.stageId)?.push(c)
    return map
  }, [visibleCards, stages])

  const now = new Date()
  const colCount = canWrite ? 7 : 6

  return (
    <div className="space-y-6">
      <BoardSearch
        value={query}
        onChange={setQuery}
        matchCount={visibleCards.length}
        totalCount={cards.length}
      />
      {stages.map((stage) => {
        const stageCards = byStage.get(stage.id) ?? []
        const dot = resolveStageColor(stage.color)
        return (
          <Card key={stage.id} className="overflow-hidden">
            <header className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: dot }}
                aria-hidden
              />
              <h2 className="text-sm font-semibold text-neutral-800">{stage.name}</h2>
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                {stageCards.length}
              </span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-100 text-left text-[11px] uppercase tracking-wide text-neutral-500">
                    <th className="px-4 py-2 font-medium">Contact</th>
                    <th className="px-3 py-2 font-medium">Subject / labels</th>
                    <th className="px-3 py-2 font-medium">Scheduled call</th>
                    <th className="px-3 py-2 font-medium">Due</th>
                    <th className="px-3 py-2 font-medium">Assignee</th>
                    <th className="px-3 py-2 font-medium">Last activity</th>
                    {canWrite ? <th className="px-3 py-2 font-medium">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {stageCards.length === 0 ? (
                    <tr>
                      <td colSpan={colCount} className="px-4 py-3 text-sm text-neutral-400">
                        No cards in this stage.
                      </td>
                    </tr>
                  ) : (
                    stageCards.map((card) => (
                      <tr
                        key={card.id}
                        onClick={() => setOpenCardId(card.id)}
                        className="cursor-pointer border-b border-neutral-50 last:border-0 hover:bg-neutral-50"
                      >
                        <td className="px-4 py-2 align-top">
                          <div className="font-semibold text-neutral-900">{card.contactName}</div>
                          {card.contactPhone || card.contactEmail ? (
                            <div
                              className="mt-0.5 flex flex-col gap-0.5 text-xs text-neutral-600"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {card.contactEmail && <EmailLink email={card.contactEmail} />}
                              {card.contactPhone && (
                                <PhoneLink phone={card.contactPhone} contactId={card.contactId} />
                              )}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex flex-wrap items-center gap-1">
                            {card.subject ? <Badge tone="info">{card.subject.name}</Badge> : null}
                            {(card.enquiryTypes ?? [])
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
                            {card.company ? (
                              <span
                                className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium text-neutral-700"
                                title="Company"
                              >
                                <span
                                  aria-hidden
                                  className="h-1.5 w-1.5 rounded-full"
                                  style={{
                                    backgroundColor: resolveStageColor(
                                      card.company.color ?? 'neutral-400',
                                    ),
                                  }}
                                />
                                {card.company.name}
                              </span>
                            ) : null}
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
                          {card.description && card.description.trim().length > 0 ? (
                            <p className="mt-1 line-clamp-1 text-xs text-neutral-500">
                              {card.description.trim()}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {card.scheduledCallAt ? (
                            <span
                              className={
                                new Date(card.scheduledCallAt).getTime() < now.getTime()
                                  ? 'inline-flex items-center gap-1 text-[11px] font-semibold text-red-700'
                                  : 'inline-flex items-center gap-1 text-[11px] font-semibold text-primary-700'
                              }
                              title="Scheduled call (UK time)"
                            >
                              <PhoneIcon size={11} />
                              {formatLondon(card.scheduledCallAt, {
                                day: '2-digit',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          ) : (
                            <span className="text-neutral-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top text-xs">
                          {card.dueAt ? (
                            <span
                              className={
                                new Date(card.dueAt).getTime() < now.getTime()
                                  ? 'font-semibold text-red-700'
                                  : 'text-neutral-600'
                              }
                            >
                              {new Intl.DateTimeFormat('en-GB', { dateStyle: 'short' }).format(
                                new Date(card.dueAt),
                              )}
                            </span>
                          ) : (
                            <span className="text-neutral-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {card.assigneeId ? (
                            <span
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary-100 text-[10px] font-semibold text-primary-800"
                              title={card.assigneeName ?? card.assigneeEmail ?? 'Assigned'}
                            >
                              {initialsOf(card.assigneeName, card.assigneeEmail)}
                            </span>
                          ) : (
                            <span className="text-neutral-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top text-xs text-neutral-500">
                          {card.lastActivityAt ? (
                            <span className="font-mono tabular-nums">
                              {formatRelativeTime(new Date(card.lastActivityAt), now)}
                            </span>
                          ) : (
                            <span className="text-neutral-300">—</span>
                          )}
                        </td>
                        {canWrite ? (
                          <td className="px-3 py-2 align-top" onClick={(e) => e.stopPropagation()}>
                            <div className="space-y-1.5">
                              {quickActions.length > 0 ? (
                                <QuickActionButtons
                                  cardId={card.id}
                                  currentStageId={card.stageId}
                                  actions={quickActions}
                                  onLocalMove={moveCardLocal}
                                  onLocalRevert={revertLocalMove}
                                />
                              ) : null}
                              <MoveCardMenu
                                cardId={card.id}
                                currentStageId={card.stageId}
                                stages={stageOptions}
                                crossBoardStages={crossBoardStages}
                                onLocalMove={moveCardLocal}
                                onLocalRevert={revertLocalMove}
                              />
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        )
      })}

      {openCardId !== null ? (
        <CardModal
          cardId={openCardId}
          open
          onClose={() => setOpenCardId(null)}
          stages={stageOptions}
          crossBoardStages={crossBoardStages}
          quickActions={quickActions}
          canWrite={canWrite}
          canComment={canComment}
          canDeleteCard={canDeleteCard}
          currentUserName={currentUserName}
        />
      ) : null}
    </div>
  )
}
