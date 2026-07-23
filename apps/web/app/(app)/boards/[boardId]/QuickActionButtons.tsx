// Per-card quick actions, driven by the BoardQuickAction catalogue.
// Each row in the catalogue renders as a chip on every card: clicking it
// fires `card.applyQuickAction` which adds the row's comment template
// to the card and moves it to the row's target stage (possibly on a
// different board). Configurable from /boards/[boardId]/settings.
//
// Cache invalidation: same fix as MoveCardMenu — we explicitly invalidate
// the card list + card detail so the kanban updates live (the user
// reported moves not landing until manual refresh).

'use client'

import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

import { resolveStageColor, stageColorTint } from '../../pipeline/stage-color'

interface QuickAction {
  id: string
  label: string
  color: string | null
  targetStageId: string
  targetStageName: string
  targetBoardName: string | null
  /** Present on the shared shape; unused here (the card face renders the
   *  tick-circle action separately). */
  isCheckbox?: boolean
}

interface Props {
  cardId: string
  currentStageId: string
  actions: ReadonlyArray<QuickAction>
  /** Optimistic local-state shift so the card jumps the instant the user
   * clicks — no waiting for the round-trip + router refresh. */
  onLocalMove?: (cardId: string, toStageId: string) => void
  /** Restores the pre-move snapshot when the server rejects the move, so
   * a failed quick action never leaves the card stranded/vanished until a
   * manual refresh. */
  onLocalRevert?: () => void
  /** Called after a successful apply. Used by the card modal (which has no
   * board-local optimistic state) to close itself + refresh the board so the
   * card visibly lands in its new column — otherwise a quick action "from
   * inside" the modal appeared to do nothing. */
  onApplied?: () => void
}

// Calm, tinted chip — a soft colour wash + matching border instead of a loud,
// fully-saturated pill (the "tacky" look ops flagged, 2026-07). The colour is
// still carried by a solid dot + the tint so each action stays recognisable.
// Colours may be hex (#10b981) or a Tailwind token (emerald-500); resolve both.
function chipStyle(color: string | null): React.CSSProperties {
  if (!color) return {}
  return {
    backgroundColor: stageColorTint(color, 0.12),
    borderColor: stageColorTint(color, 0.35),
  }
}

export function QuickActionButtons({
  cardId,
  currentStageId,
  actions,
  onLocalMove,
  onLocalRevert,
  onApplied,
}: Props) {
  const utils = trpc.useUtils()
  const apply = trpc.card.applyQuickAction.useMutation({
    onSuccess: async (_data, vars) => {
      const fired = actions.find((a) => a.id === vars.quickActionId)
      toast.success(
        fired
          ? `${fired.label} → ${
              fired.targetBoardName
                ? `${fired.targetBoardName} · ${fired.targetStageName}`
                : fired.targetStageName
            }`
          : 'Applied',
      )
      // Optimistic move already shifted the card; just catch up other surfaces.
      // No router.refresh() — that reloaded the whole board on every click.
      await Promise.all([
        utils.card.list.invalidate(),
        utils.card.get.invalidate({ id: cardId }),
        utils.card.quickActions.list.invalidate(),
      ])
      // Surfaces without board-local optimistic state (the card modal) reconcile
      // here so the move is actually reflected.
      onApplied?.()
    },
    onError: (e) => {
      // Snap the optimistic move back (the local snapshot restores it) — no
      // full-page refresh needed.
      onLocalRevert?.()
      toast.error(e.message ?? 'Could not apply quick action')
    },
  })

  const visible = actions.filter((a) => a.targetStageId !== currentStageId)
  if (visible.length === 0) return null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {visible.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={apply.isPending}
          onClick={(e) => {
            // Don't trigger the card-modal click on the parent.
            e.stopPropagation()
            // Optimistic shift first so the card jumps instantly. The
            // server mutation follows; if it errors, the next router
            // refresh / invalidation will snap it back.
            if (onLocalMove && action.targetStageId !== currentStageId) {
              onLocalMove(cardId, action.targetStageId)
            }
            apply.mutate({ cardId, quickActionId: action.id })
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:opacity-60"
          style={chipStyle(action.color)}
          title={
            action.targetBoardName
              ? `→ ${action.targetBoardName} · ${action.targetStageName}`
              : `→ ${action.targetStageName}`
          }
        >
          {action.color ? (
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: resolveStageColor(action.color) }}
            />
          ) : null}
          {action.label}
        </button>
      ))}
    </div>
  )
}
