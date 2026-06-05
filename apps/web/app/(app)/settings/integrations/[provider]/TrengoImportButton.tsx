// "Import last 8 months" button for Trengo. Unlike the 90-day auto-on-connect
// backfill, this is an explicit, operator-triggered import that CREATES a
// Contact for senders not already in the CRM (tagged "Trengo import" so the
// batch is reviewable). CEO | Senior Manager only — the server procedure
// enforces it too, and requires the caller to have connected a Trengo token.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

const WINDOW_DAYS = 243 // ~8 months

export function TrengoImportButton(): JSX.Element {
  const router = useRouter()
  const [done, setDone] = useState(false)
  const start = trpc.admin.backfill.trengoImport.useMutation({
    onSuccess: () => {
      setDone(true)
      toast.success('Import started — progress shows in the banner above.')
      router.refresh()
    },
    onError: (e) => {
      toast.error(e.message ?? 'Could not start the import')
    },
  })

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={start.isPending || done}
      onClick={() => {
        if (
          !window.confirm(
            'Import roughly the last 8 months of Trengo history and create a Contact for every unknown sender? New contacts are tagged "Trengo import" so you can review or clean them up.',
          )
        ) {
          return
        }
        start.mutate({ windowDays: WINDOW_DAYS, createContacts: true })
      }}
    >
      {start.isPending
        ? 'Starting…'
        : done
          ? 'Import queued'
          : 'Import last 8 months'}
    </Button>
  )
}
