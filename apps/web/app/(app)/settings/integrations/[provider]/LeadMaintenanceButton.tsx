// One-click retroactive repair for old leads/contacts (Manager+): backfills
// missing country codes from the IP (geo waterfall → phone dial code), fills
// the converted contacts' blank countries, upgrades as-typed phones to E.164,
// and renames freebie-named contacts ("PLAB Questions") to their email.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

export function LeadMaintenanceButton(): JSX.Element {
  const [done, setDone] = useState(false)
  const run = trpc.lead.runMaintenance.useMutation({
    onSuccess: () => {
      setDone(true)
      toast.success(
        'Repair started — it works through old leads in the background (a few minutes for large volumes).',
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
            'Fix old leads now? This fills missing country codes from each lead’s IP address (falling back to the phone’s dial code), sets the contact’s country, upgrades non-international phone numbers to full E.164, and renames contacts saved as a freebie title (e.g. “PLAB Questions”) to their email address. Only blank/malformed values are touched.',
          )
        ) {
          run.mutate()
        }
      }}
    >
      {run.isPending ? 'Starting…' : done ? 'Repair running' : 'Fix old leads (countries + names)'}
    </Button>
  )
}
