// Per-invoice email & activity history. Pulls the platform's timeline
// (GET /invoices/:id/activity) — every send, reminder, payment, and status
// change with its timestamp — so staff can see the entire email history and
// exactly when reminders went out (ADR 0036). A summary strip up top surfaces
// the mirrored lastEmailedAt / lastReminderAt even before the timeline loads.

'use client'

import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { trpc } from '@/lib/trpc/client'

const londonDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function fmt(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return '—'
  return londonDateTime.format(date)
}

// Heuristic: which timeline entries are email events (so we can badge them).
function isEmailEvent(type: string | null): boolean {
  if (!type) return false
  const t = type.toLowerCase()
  return t.includes('email') || t.includes('sent') || t.includes('remind')
}

export function InvoiceActivityModal({
  invoicingId,
  invoiceNumber,
  lastEmailedAt,
  lastReminderAt,
  onClose,
}: {
  invoicingId: string | null
  invoiceNumber?: string | null
  lastEmailedAt?: Date | string | null
  lastReminderAt?: Date | string | null
  onClose: () => void
}) {
  const activity = trpc.invoicing.invoices.activity.useQuery(
    { invoicingId: invoicingId ?? '' },
    { enabled: invoicingId !== null, retry: false },
  )

  const rows = activity.data ?? []

  return (
    <Modal
      open={invoicingId !== null}
      onClose={onClose}
      size="lg"
      title={`Email & activity history${invoiceNumber ? ` — ${invoiceNumber}` : ''}`}
      footer={
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4 p-4">
        {/* Summary strip from the mirror (always available). */}
        <dl className="grid grid-cols-2 gap-3 rounded-md bg-neutral-50 p-3 text-xs">
          <div>
            <dt className="text-neutral-500">Last emailed</dt>
            <dd className="text-neutral-800">{fmt(lastEmailedAt)}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Last reminder</dt>
            <dd className="text-neutral-800">{fmt(lastReminderAt)}</dd>
          </div>
        </dl>

        {/* Full timeline from the platform. */}
        {activity.isLoading ? (
          <p className="text-sm text-neutral-500">Loading history…</p>
        ) : activity.isError ? (
          <p className="text-sm text-neutral-500">
            Couldn’t load the platform timeline. The send/reminder times above are from the CRM
            mirror.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-neutral-500">No activity recorded yet.</p>
        ) : (
          <ol className="space-y-2">
            {rows.map((r, i) => (
              <li
                key={r.id ?? i}
                className="flex items-start gap-3 border-l-2 border-neutral-200 pl-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-neutral-800">
                      {r.type ? r.type.replace(/_/g, ' ') : 'event'}
                    </span>
                    {isEmailEvent(r.type) && (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-800">
                        email
                      </span>
                    )}
                    {r.source && (
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                        {r.source}
                      </span>
                    )}
                  </div>
                  {r.message && <p className="mt-0.5 text-xs text-neutral-600">{r.message}</p>}
                </div>
                <time className="shrink-0 whitespace-nowrap text-[11px] text-neutral-400">
                  {fmt(r.createdAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  )
}
