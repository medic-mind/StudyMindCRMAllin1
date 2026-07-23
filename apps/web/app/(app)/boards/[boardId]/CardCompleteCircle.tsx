// Todoist-style tick-circle on the card face (operator request, 2026-07). It
// fires the board's designated "checkbox" quick action (the default board seeds
// "Call completed") — an empty circle that fills with a tick on hover; clicking
// it moves the card to the action's target stage (cross-board to Completed
// Calls). Same apply + optimistic-move + invalidation behaviour as
// QuickActionButtons, just rendered as a circle instead of a chip.

'use client'

import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

interface CheckboxAction {
  id: string
  label: string
  targetStageId: string
  targetStageName: string
  targetBoardName: string | null
}

interface Props {
  cardId: string
  action: CheckboxAction
  onLocalMove?: (cardId: string, toStageId: string) => void
  onLocalRevert?: () => void
  onApplied?: () => void
}

export function CardCompleteCircle({
  cardId,
  action,
  onLocalMove,
  onLocalRevert,
  onApplied,
}: Props) {
  const utils = trpc.useUtils()
  const target = action.targetBoardName
    ? `${action.targetBoardName} · ${action.targetStageName}`
    : action.targetStageName

  const apply = trpc.card.applyQuickAction.useMutation({
    onSuccess: async () => {
      toast.success(`${action.label} → ${target}`)
      await Promise.all([
        utils.card.list.invalidate(),
        utils.card.get.invalidate({ id: cardId }),
        utils.card.quickActions.list.invalidate(),
      ])
      onApplied?.()
    },
    onError: (e) => {
      onLocalRevert?.()
      toast.error(e.message ?? 'Could not complete the card')
    },
  })

  return (
    <button
      type="button"
      disabled={apply.isPending}
      aria-label={`${action.label} → ${target}`}
      title={`${action.label} → ${target}`}
      onClick={(e) => {
        e.stopPropagation()
        onLocalMove?.(cardId, action.targetStageId)
        apply.mutate({ cardId, quickActionId: action.id })
      }}
      className="pointer-events-auto mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-neutral-300 text-transparent transition-colors hover:border-emerald-500 hover:bg-emerald-50 hover:text-emerald-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:opacity-50"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </button>
  )
}
