'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

/**
 * Admin trigger to import ALL current camp bookings into the CRM. Fires the
 * background backfill job; the recurring sync then keeps things in step.
 * Only rendered for CEO / Senior Manager (gated server-side too).
 */
export function BackfillButton() {
  const [started, setStarted] = useState(false)
  const backfill = trpc.summerCamp.backfill.useMutation({
    onSuccess: () => {
      setStarted(true)
      toast.success('Backfill started — all current bookings will import in the background.')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={backfill.isPending || started}
      onClick={() => backfill.mutate()}
    >
      {started ? 'Backfill started' : backfill.isPending ? 'Starting…' : 'Backfill all bookings'}
    </Button>
  )
}
