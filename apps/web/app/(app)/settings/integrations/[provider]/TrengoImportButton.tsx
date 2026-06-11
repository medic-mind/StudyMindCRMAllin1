// "Import Trengo history" control. Unlike the 90-day auto-on-connect
// backfill, this is an explicit, operator-triggered import that CREATES a
// Contact for senders not already in the CRM (tagged "Trengo import" so the
// batch is reviewable). The window is selectable — from 8 months up to
// "everything" (5 years) — because a CRM being stood up fresh wants the whole
// history, not a slice. CEO | Senior Manager only — the server procedure
// enforces it too, and requires the caller to have connected a Trengo token.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

const WINDOW_OPTIONS = [
  // Quick sync: re-pulls the recent window to heal any missed webhook
  // deliveries (idempotent — nothing duplicates, blanks get enriched).
  { days: 7, label: 'Last 7 days (quick sync)' },
  { days: 243, label: 'Last 8 months' },
  { days: 365, label: 'Last 12 months' },
  { days: 730, label: 'Last 2 years' },
  { days: 1825, label: 'Everything (up to 5 years)' },
] as const

export function TrengoImportButton(): JSX.Element {
  const router = useRouter()
  const [windowDays, setWindowDays] = useState<number>(243)
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

  const selected =
    WINDOW_OPTIONS.find((o) => o.days === windowDays) ?? WINDOW_OPTIONS[0]

  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="trengo-import-window">
        Import window
      </label>
      <select
        id="trengo-import-window"
        className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-900"
        value={windowDays}
        disabled={start.isPending || done}
        onChange={(e) => setWindowDays(Number(e.target.value))}
      >
        {WINDOW_OPTIONS.map((o) => (
          <option key={o.days} value={o.days}>
            {o.label}
          </option>
        ))}
      </select>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={start.isPending || done}
        onClick={() => {
          if (
            !window.confirm(
              `Import Trengo history (${selected.label.toLowerCase()}) and create a Contact for every unknown sender? New contacts are tagged "Trengo import" so you can review or clean them up. Imported conversations appear in the comms centre and on each contact's timeline.`,
            )
          ) {
            return
          }
          start.mutate({ windowDays, createContacts: true })
        }}
      >
        {start.isPending ? 'Starting…' : done ? 'Import queued' : 'Import history'}
      </Button>
    </div>
  )
}
