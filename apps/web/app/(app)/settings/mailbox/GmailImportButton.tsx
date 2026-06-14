'use client'

// Import older Gmail history for the connected mailbox over a chosen window
// (the 90-day backfill runs automatically on connect; this is the "import
// everything" control). Mirrors the Trengo "Import history" pattern. Progress
// shows in the global backfill banner. Matches existing contacts + B2B accounts
// only — never creates ghost contacts.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

const WINDOW_OPTIONS = [
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
  { days: 730, label: 'Last 2 years' },
  { days: 1825, label: 'Last 5 years' },
  { days: 7305, label: 'Everything (all history)' },
] as const

export function GmailImportButton(): JSX.Element {
  const router = useRouter()
  const [windowDays, setWindowDays] = useState<number>(365)
  const [queued, setQueued] = useState(false)
  const start = trpc.admin.backfill.gmailImport.useMutation({
    onSuccess: () => {
      setQueued(true)
      toast.success('Import started — progress shows in the banner at the top.')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not start the import'),
  })

  const selected = WINDOW_OPTIONS.find((o) => o.days === windowDays) ?? WINDOW_OPTIONS[1]

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="gmail-import-window" className="text-xs text-neutral-500">
        Import history
      </label>
      <select
        id="gmail-import-window"
        className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-200"
        value={windowDays}
        disabled={start.isPending || queued}
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
        disabled={start.isPending || queued}
        onClick={() => {
          if (
            !window.confirm(
              `Import ${selected.label.toLowerCase()} of email for this mailbox and add it to the timeline of matched contacts and B2B accounts? Existing contacts only — no new contacts are created.`,
            )
          ) {
            return
          }
          start.mutate({ windowDays })
        }}
      >
        {start.isPending ? 'Starting…' : queued ? 'Import queued' : 'Import'}
      </Button>
    </div>
  )
}
