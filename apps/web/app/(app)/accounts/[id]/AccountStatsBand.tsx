// At-a-glance stats band for the B2B account detail page. A row of metric
// tiles: students, contracted/delivered hours, invoiced / paid / outstanding
// (from the live B2B Invoices Platform mirror), comms activity, and when we
// last spoke to anyone linked to the account. Server component — pure render
// of the pre-shaped `stats` from businessAccount.get.

import { Card } from '@/components/ui/card'
import { formatMoneyMinor } from '@/lib/format/money'

interface AccountStats {
  studentCount: number
  hoursContracted: number
  hoursDelivered: number
  amountPaidMinor: number
  callCount: number
  textCount: number
  emailCount: number
  lastContactedAt: Date | string | null
  invoiceCount: number
  invoicedMinor: number
  invoicePaidMinor: number
  outstandingMinor: number
}

function relative(d: Date | string | null): string {
  if (!d) return 'never'
  const ms = Date.now() - new Date(d).getTime()
  const day = Math.floor(ms / 86_400_000)
  if (day <= 0) return 'today'
  if (day === 1) return 'yesterday'
  if (day < 30) return `${day}d ago`
  if (day < 365) return `${Math.floor(day / 30)}mo ago`
  return `${Math.floor(day / 365)}y ago`
}

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'good' | 'warn'
}) {
  const valueTone =
    tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-neutral-900'
  return (
    <Card className="px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-lg tabular-nums ${valueTone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-neutral-500">{sub}</div>}
    </Card>
  )
}

export function AccountStatsBand({ stats }: { stats: AccountStats }) {
  const activity = stats.callCount + stats.textCount + stats.emailCount
  return (
    <section
      aria-label="Account summary"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      <Tile label="Students" value={String(stats.studentCount)} />
      <Tile
        label="Hours"
        value={stats.hoursContracted > 0 ? `${stats.hoursContracted}h` : '—'}
        sub={stats.hoursContracted > 0 ? `${stats.hoursDelivered}h delivered` : 'none contracted'}
      />
      <Tile
        label="Invoiced"
        value={stats.invoicedMinor > 0 ? formatMoneyMinor(stats.invoicedMinor) : '—'}
        sub={`${stats.invoiceCount} ${stats.invoiceCount === 1 ? 'invoice' : 'invoices'}`}
      />
      <Tile
        label="Paid"
        value={stats.invoicePaidMinor > 0 ? formatMoneyMinor(stats.invoicePaidMinor) : '—'}
        tone={stats.invoicePaidMinor > 0 ? 'good' : 'default'}
      />
      <Tile
        label="Outstanding"
        value={stats.outstandingMinor > 0 ? formatMoneyMinor(stats.outstandingMinor) : '—'}
        tone={stats.outstandingMinor > 0 ? 'warn' : 'default'}
      />
      <Tile
        label="Activity"
        value={String(activity)}
        sub={`${stats.callCount} calls · ${stats.textCount} msg · ${stats.emailCount} email — ${relative(stats.lastContactedAt)}`}
      />
    </section>
  )
}
