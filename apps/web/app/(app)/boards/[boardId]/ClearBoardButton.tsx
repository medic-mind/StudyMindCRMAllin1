// Clear the whole board in one confirmed, audited action — every live card is
// soft-archived (reversible mechanics; customers + their history untouched).
// Manager+ (server enforces via card.clearBoard). CLAUDE.md §3: destructive
// bulk actions always confirm first.

'use client'

import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { trpc } from '@/lib/trpc/client'

export function ClearBoardButton({
  boardId,
  boardName,
  cardCount,
}: {
  boardId: string
  boardName: string
  cardCount: number
}): JSX.Element | null {
  const router = useRouter()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const clear = trpc.card.clearBoard.useMutation({
    onSuccess: async (r) => {
      const n = r?.archived ?? 0
      toast.success(`Board cleared — ${n} card${n === 1 ? '' : 's'} archived.`)
      await utils.card.list.invalidate()
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not clear the board'),
  })

  if (cardCount === 0) return null

  async function onClick(): Promise<void> {
    const ok = await confirm({
      title: `Clear "${boardName}" in full?`,
      body: `All ${cardCount} card${cardCount === 1 ? '' : 's'} on this board will be archived in one go. Customers and their timeline history are untouched, and the action is recorded in the audit log. Stages, labels and quick actions stay as they are.`,
      confirmLabel: 'Clear board',
      tone: 'danger',
    })
    if (!ok) return
    clear.mutate({ boardId })
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={clear.isPending}
      onClick={() => void onClick()}
      className="text-red-700 hover:bg-red-50"
    >
      {clear.isPending ? 'Clearing…' : 'Clear board'}
    </Button>
  )
}
