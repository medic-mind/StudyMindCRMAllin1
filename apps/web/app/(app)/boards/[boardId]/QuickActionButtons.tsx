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

import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

interface QuickAction {
  id: string
  label: string
  color: string | null
  targetStageId: string
  targetStageName: string
  targetBoardName: string | null
}

interface Props {
  cardId: string
  currentStageId: string
  actions: ReadonlyArray<QuickAction>
  /** Optimistic local-state shift so the card jumps the instant the user
   * clicks — no waiting for the round-trip + router refresh. */
  onLocalMove?: (cardId: string, toStageId: string) => void
}

function chipStyle(color: string | null): React.CSSProperties {
  if (!color) return {}
  return {
    backgroundColor: color,
    color: '#ffffff',
    borderColor: color,
  }
}

export function QuickActionButtons({
  cardId,
  currentStageId,
  actions,
  onLocalMove,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const apply = trpc.card.applyQuickAction.useMutation({
    onSuccess: async (_data, vars) => {
      const fired = actions.find((a) => a.id === vars.quickActionId)
      toast.success(fired ? `${fired.label} → ${fired.targetStageName}` : 'Applied')
      await Promise.all([
        utils.card.list.invalidate(),
        utils.card.get.invalidate({ id: cardId }),
        utils.card.quickActions.list.invalidate(),
      ])
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not apply quick action'),
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
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] font-medium text-neutral-800 hover:brightness-95 disabled:opacity-60"
          style={chipStyle(action.color)}
          title={
            action.targetBoardName
              ? `→ ${action.targetBoardName} · ${action.targetStageName}`
              : `→ ${action.targetStageName}`
          }
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
