// Shared tonal status pills for the Summer Camp surfaces — one mapping used by
// every camps table/card so status always reads the same way (§4).

import { Badge, type BadgeTone } from '@/components/ui/badge'

const BOOKING_TONES: Record<string, { tone: BadgeTone; label: string }> = {
  confirmed: { tone: 'success', label: 'Confirmed' },
  pending: { tone: 'warn', label: 'Pending' },
  waitlist: { tone: 'info', label: 'Waitlist' },
  cancelled: { tone: 'danger', label: 'Cancelled' },
}

export function BookingStatusBadge({ status }: { status: string | null | undefined }) {
  const entry = BOOKING_TONES[status ?? '']
  if (!entry) return <Badge tone="neutral">{status ?? 'Unknown'}</Badge>
  return (
    <Badge tone={entry.tone} dot>
      {entry.label}
    </Badge>
  )
}

const CAMP_TONES: Record<string, { tone: BadgeTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  draft: { tone: 'neutral', label: 'Draft' },
  archived: { tone: 'neutral', label: 'Archived' },
}

export function CampStatusBadge({ status }: { status: string | null | undefined }) {
  const entry = CAMP_TONES[status ?? '']
  if (!entry) return null
  return (
    <Badge tone={entry.tone} dot={entry.tone === 'success'}>
      {entry.label}
    </Badge>
  )
}

const PURCHASE_TONES: Record<string, { tone: BadgeTone; label: string }> = {
  pending: { tone: 'warn', label: 'Pending' },
  failed: { tone: 'danger', label: 'Failed' },
  booking_created: { tone: 'success', label: 'Booking created' },
  dismissed: { tone: 'neutral', label: 'Dismissed' },
}

export function PurchaseStatusBadge({ status }: { status: string }) {
  const entry = PURCHASE_TONES[status] ?? { tone: 'neutral' as BadgeTone, label: status }
  return (
    <Badge tone={entry.tone} dot={entry.tone !== 'neutral'}>
      {entry.label}
    </Badge>
  )
}

/** CSP-safe segmented fill bar (no inline styles): 24 fixed segments coloured
 *  proportionally — confirmed (emerald) · pending (amber) · waitlist (sky). */
export function FillBar({
  confirmed,
  pending,
  waitlist,
  total,
}: {
  confirmed: number
  pending: number
  waitlist: number
  total: number
}) {
  const SEGMENTS = 24
  const safeTotal = Math.max(total, 1)
  const c = Math.round((confirmed / safeTotal) * SEGMENTS)
  const p = Math.round((pending / safeTotal) * SEGMENTS)
  const w = Math.round((waitlist / safeTotal) * SEGMENTS)
  return (
    <div
      className="flex gap-px overflow-hidden rounded-full"
      role="img"
      aria-label={`${confirmed} confirmed, ${pending} pending, ${waitlist} waitlist of ${total}`}
    >
      {Array.from({ length: SEGMENTS }, (_, i) => {
        const colour =
          i < c ? 'bg-emerald-400' : i < c + p ? 'bg-amber-400' : i < c + p + w ? 'bg-sky-400' : 'bg-neutral-100'
        return <span key={i} className={`h-1.5 flex-1 ${colour}`} />
      })}
    </div>
  )
}
