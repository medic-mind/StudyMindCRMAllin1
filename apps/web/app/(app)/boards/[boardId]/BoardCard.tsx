// Client wrapper for a single board card. Clicking the card body opens the
// detail modal; the contact name remains a secondary link (cmd/ctrl-click or
// the explicit link still navigates). ADR 0018, CLAUDE.md §26.

'use client'

import Link from 'next/link'
import { useState } from 'react'

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

interface Props {
  card: CardData
  stageId: string
  stages: ReadonlyArray<StageOption>
  tickStageId: string | null
  tickStageName: string | null
  xStageId: string | null
  xStageName: string | null
  canWrite: boolean
  canComment: boolean
  currentUserName: string
}

export function BoardCard({
  card,
  stageId,
  stages,
  tickStageId,
  tickStageName,
  xStageId,
  xStageName,
  canWrite,
  canComment,
  currentUserName,
}: Props) {
  const [open, setOpen] = useState(false)
  const now = new Date()

  return (
    <li className="bg-white p-3 text-sm">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full min-w-0 truncate text-left font-medium text-neutral-900 hover:text-primary-700 hover:underline"
      >
        {card.contactName}
      </button>
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
      <p className="mt-1">
        <Link
          href={`/contacts/${card.contactId}`}
          className="text-[10px] text-neutral-500 hover:text-primary-700 hover:underline"
        >
          Open contact →
        </Link>
      </p>
      {canWrite ? (
        <>
          <QuickActionButtons
            cardId={card.id}
            currentStageId={stageId}
            tickStageId={tickStageId}
            tickStageName={tickStageName}
            xStageId={xStageId}
            xStageName={xStageName}
          />
          <div className="mt-2">
            <MoveCardMenu cardId={card.id} currentStageId={stageId} stages={stages} />
          </div>
        </>
      ) : null}

      <CardModal
        cardId={card.id}
        open={open}
        onClose={() => setOpen(false)}
        stages={stages}
        tickStageId={tickStageId}
        tickStageName={tickStageName}
        xStageId={xStageId}
        xStageName={xStageName}
        canWrite={canWrite}
        canComment={canComment}
        currentUserName={currentUserName}
      />
    </li>
  )
}
