// Per-card quick actions. ADR 0018. A tick moves the card to the board's
// configured "completed" stage (tickActionStageId); the cross moves it to
// the "not answered" stage (xActionStageId). Both target stages are set per
// board in board settings; if a board hasn't configured them the buttons
// don't render. Uses the same audited card.move mutation as the dropdown.

'use client'

import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'
import { CheckCircleIcon, XCircleIcon } from '@/components/ui/icon'

interface Props {
  cardId: string
  currentStageId: string
  tickStageId: string | null
  tickStageName: string | null
  xStageId: string | null
  xStageName: string | null
}

export function QuickActionButtons({
  cardId,
  currentStageId,
  tickStageId,
  tickStageName,
  xStageId,
  xStageName,
}: Props) {
  const router = useRouter()
  const move = trpc.card.move.useMutation({
    onSuccess: (_d, vars) => {
      toast.success(vars.toStageId === tickStageId ? 'Marked complete' : 'Marked not answered')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not move card'),
  })

  const showTick = tickStageId && tickStageId !== currentStageId
  const showX = xStageId && xStageId !== currentStageId
  if (!showTick && !showX) return null

  return (
    <div className="mt-2 flex items-center gap-1.5">
      {showTick ? (
        <button
          type="button"
          disabled={move.isPending}
          onClick={() => move.mutate({ cardId, toStageId: tickStageId })}
          className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-60"
          aria-label={`Move to ${tickStageName ?? 'completed'}`}
          title={`Move to ${tickStageName ?? 'completed'}`}
        >
          <CheckCircleIcon size={13} />
          {tickStageName ?? 'Complete'}
        </button>
      ) : null}
      {showX ? (
        <button
          type="button"
          disabled={move.isPending}
          onClick={() => move.mutate({ cardId, toStageId: xStageId })}
          className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-800 hover:bg-rose-100 disabled:opacity-60"
          aria-label={`Move to ${xStageName ?? 'not answered'}`}
          title={`Move to ${xStageName ?? 'not answered'}`}
        >
          <XCircleIcon size={13} />
          {xStageName ?? 'Not answered'}
        </button>
      ) : null}
    </div>
  )
}
