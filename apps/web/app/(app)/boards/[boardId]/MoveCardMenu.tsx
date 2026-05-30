// Per-card "Move to…" dropdown. ADR 0018. Supports both same-board and
// cross-board moves: when `crossBoardStages` is provided, those stages
// appear in a second `<optgroup>` so the agent can jump a card off to
// a different pipeline in one click. CLAUDE.md §20.
//
// Cache: we invalidate the card list + the card detail query directly on
// success so the kanban updates live; the user reported the legacy
// `router.refresh()` alone wasn't always refreshing the kanban view.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

interface StageOption {
  id: string
  name: string
}

interface CrossBoardGroup {
  boardId: string
  boardName: string
  stages: ReadonlyArray<StageOption>
}

interface Props {
  cardId: string
  currentStageId: string
  /** Same-board stages — primary options. */
  stages: ReadonlyArray<StageOption>
  /** Other boards' stages — rendered under a "Move to other board" optgroup. */
  crossBoardStages?: ReadonlyArray<CrossBoardGroup>
  /** Optimistic local-state shift so the card jumps the instant the
   * user picks a target. */
  onLocalMove?: (cardId: string, toStageId: string) => void
}

export function MoveCardMenu({
  cardId,
  currentStageId,
  stages,
  crossBoardStages = [],
  onLocalMove,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [pending, setPending] = useState(false)
  const move = trpc.card.move.useMutation({
    onSuccess: async (_data, vars) => {
      const dest =
        stages.find((s) => s.id === vars.toStageId) ??
        crossBoardStages
          .flatMap((g) => g.stages)
          .find((s) => s.id === vars.toStageId)
      toast.success(`Moved to ${dest?.name ?? 'new stage'}`)
      setPending(false)
      // Invalidate everything the kanban shows — the user reported the
      // dropdown sometimes only updated on full refresh. Invalidate the
      // list for every board we may have touched (source + target).
      await Promise.all([
        utils.card.list.invalidate(),
        utils.card.get.invalidate({ id: cardId }),
        utils.card.quickActions.list.invalidate(),
      ])
      router.refresh()
    },
    onError: (e) => {
      setPending(false)
      toast.error(e.message ?? 'Could not move card')
    },
  })

  const sameBoardTargets = stages.filter((s) => s.id !== currentStageId)
  const crossBoardTargets = crossBoardStages
    .map((g) => ({
      boardName: g.boardName,
      stages: g.stages.filter((s) => s.id !== currentStageId),
    }))
    .filter((g) => g.stages.length > 0)
  const noOtherBoards = crossBoardStages.length === 0
  if (sameBoardTargets.length === 0 && crossBoardTargets.length === 0) return null

  return (
    <label className="block">
      <span className="sr-only">Move card</span>
      <select
        disabled={move.isPending}
        value=""
        onChange={(e) => {
          const next = e.target.value
          if (!next) return
          setPending(true)
          // Optimistic local move first so the column jump is instant.
          if (onLocalMove) onLocalMove(cardId, next)
          move.mutate({ cardId, toStageId: next })
        }}
        className="w-full rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
        aria-label="Move card to another stage"
      >
        <option value="">{pending ? 'Moving…' : 'Move to…'}</option>
        {sameBoardTargets.length > 0 && (
          <optgroup label="This board">
            {sameBoardTargets.map((s) => (
              <option key={s.id} value={s.id}>
                → {s.name}
              </option>
            ))}
          </optgroup>
        )}
        {crossBoardTargets.map((g) => (
          <optgroup key={g.boardName} label={`→ ${g.boardName}`}>
            {g.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </optgroup>
        ))}
        {noOtherBoards && (
          <option disabled value="">
            ─ Create another board to enable cross-pipeline moves
          </option>
        )}
      </select>
    </label>
  )
}
