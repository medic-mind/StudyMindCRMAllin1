// "Backfill last 90 days" button for shared-token providers (Aircall, Slack).
// Per-agent providers (Gmail, Trengo) auto-trigger on connect, so this button
// only renders for aircall/slack. CEO | Senior Manager only — the server
// procedure enforces that too. ADR 0017.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Props {
  provider: 'aircall' | 'slack'
}

export function BackfillButton({ provider }: Props): JSX.Element {
  const router = useRouter()
  const [done, setDone] = useState(false)
  // Aircall imports a clean 1 month; Slack keeps the standard 90 days.
  const windowLabel = provider === 'aircall' ? 'last 1 month' : 'last 90 days'
  const start = trpc.admin.backfill.start.useMutation({
    onSuccess: () => {
      setDone(true)
      toast.success('Backfill started — progress shows in the banner.')
      router.refresh()
    },
    onError: (e) => {
      toast.error(e.message ?? 'Could not start backfill')
    },
  })

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={start.isPending || done}
      onClick={() => start.mutate({ provider })}
    >
      {start.isPending
        ? 'Starting…'
        : done
          ? 'Backfill queued'
          : `Backfill ${windowLabel}`}
    </Button>
  )
}
