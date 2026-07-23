// One-click retroactive repair for old leads (Manager+): re-parses each
// existing lead's stored form payload with the improved "Call day"/"Call time"
// parser and sets the backing pipeline card's scheduled call where it is still
// blank — so historic enquiries that requested a call time finally show it on
// the board. Idempotent (only blank cards are touched); runs in the background.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

export function LeadCallTimeBackfillButton(): JSX.Element {
  const [done, setDone] = useState(false)
  const run = trpc.lead.backfillCallTimes.useMutation({
    onSuccess: () => {
      setDone(true)
      toast.success(
        'Started — it works through old enquiries in the background and sets the call time on any card that was missing one.',
      )
    },
    onError: (e) => toast.error(e.message ?? 'Could not start the repair'),
  })
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={run.isPending || done}
      onClick={() => {
        if (
          window.confirm(
            'Fill in call times on old enquiry cards now? This re-reads each past web enquiry’s "Call day"/"Call time" and sets the card’s scheduled call where it’s currently blank. Nothing already set is changed.',
          )
        ) {
          run.mutate()
        }
      }}
    >
      {run.isPending ? 'Starting…' : done ? 'Backfill running' : 'Fill call times on old cards'}
    </Button>
  )
}
