// Cancel a pending/running backfill job. The page's diagnostics tell an
// operator to "cancel the stuck job" but there was previously no control to do
// it — a stalled `running` row then blocks every new import via
// BackfillAlreadyRunningError. This is the direct, Inngest-independent clear:
// it writes the cancellation straight to the DB through tRPC, so it works even
// when the worker is not picking jobs up. CEO | Senior Manager only (the
// server procedure enforces it too). ADR 0017.

'use client'

import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Props {
  jobId: string
}

export function CancelBackfillButton({ jobId }: Props): JSX.Element {
  const router = useRouter()
  const cancel = trpc.admin.backfill.cancel.useMutation({
    onSuccess: () => {
      toast.success('Backfill cancelled — you can start a fresh import now.')
      router.refresh()
    },
    onError: (e) => {
      toast.error(e.message ?? 'Could not cancel backfill')
    },
  })

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={cancel.isPending}
      onClick={() => cancel.mutate({ id: jobId })}
    >
      {cancel.isPending ? 'Cancelling…' : 'Cancel'}
    </Button>
  )
}
