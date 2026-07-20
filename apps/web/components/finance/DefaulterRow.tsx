// One Direct Debit defaulter row (Slice B). Client island: expands to a
// drill-down showing the payment/instalment timeline plus a jump to the family
// to send a reminder. CLAUDE.md §3 — we never auto-charge or auto-dun; every
// action below requires a person to confirm.

'use client'

import Link from 'next/link'
import { useState } from 'react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Td, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

const REASON_LABEL: Record<string, string> = {
  mandate_inactive_with_balance: 'Inactive mandate + balance',
  reverted_payment_not_recollected: 'Reverted payment not re-collected',
  multiple_failed_direct_debits_90d: '2+ failed DDs in 90d',
}

const MANDATE_TONE: Record<string, BadgeTone> = {
  failed: 'danger',
  cancelled: 'danger',
  expired: 'warn',
}

interface Defaulter {
  familyId: string
  billingContactName: string | null
  mandateStatus: string | null
  failedCount: number
  lastFailureAt: Date | null
  totalPaidMinor: number
  totalOwedMinor: number
  outstandingMinor: number
  reasons: string[]
}

export function DefaulterRow({ defaulter: d }: { defaulter: Defaulter }): JSX.Element {
  const [open, setOpen] = useState(false)
  const detail = trpc.finance.directDebit.detail.useQuery(
    { familyId: d.familyId },
    { enabled: open },
  )

  return (
    <>
      <Tr>
        <Td>
          <Link
            href={`/contacts/families/${d.familyId}`}
            className="font-medium text-primary-700 hover:underline"
          >
            {d.billingContactName ?? `Family ${d.familyId.slice(-6)}`}
          </Link>
        </Td>
        <Td>
          {d.mandateStatus ? (
            <Badge tone={MANDATE_TONE[d.mandateStatus] ?? 'neutral'}>{d.mandateStatus}</Badge>
          ) : (
            <span className="text-xs text-neutral-400">—</span>
          )}
        </Td>
        <Td className="font-mono tabular-nums">{d.failedCount}</Td>
        <Td className="text-xs text-neutral-600">
          {d.lastFailureAt ? formatRelativeTime(new Date(d.lastFailureAt)) : '—'}
        </Td>
        <Td className="text-right font-mono tabular-nums">
          {formatMoneyMinor(d.totalPaidMinor)}
        </Td>
        <Td className="text-right font-mono tabular-nums">
          {formatMoneyMinor(d.totalOwedMinor)}
        </Td>
        <Td className="text-right font-mono font-semibold tabular-nums text-red-700">
          {formatMoneyMinor(d.outstandingMinor)}
        </Td>
        <Td>
          <div className="flex flex-wrap gap-1">
            {d.reasons.map((r) => (
              <Badge key={r} tone="warn">
                {REASON_LABEL[r] ?? r}
              </Badge>
            ))}
          </div>
        </Td>
        <Td className="text-right">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? 'Hide' : 'Open'}
          </Button>
        </Td>
      </Tr>

      {open ? (
        <Tr>
          <Td colSpan={9} className="bg-neutral-50">
            <div className="space-y-4 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/contacts/families/${d.familyId}`}
                  className="inline-flex h-8 items-center rounded-md bg-neutral-100 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
                >
                  Send reminder (open family)
                </Link>
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Payment &amp; instalment history
                </h3>
                {detail.isLoading ? (
                  <p className="mt-2 text-sm text-neutral-500">Loading history…</p>
                ) : detail.isError ? (
                  <p className="mt-2 text-sm text-red-700">
                    Could not load history. Try again.
                  </p>
                ) : detail.data ? (
                  <DetailHistory data={detail.data} />
                ) : null}
              </div>
            </div>
          </Td>
        </Tr>
      ) : null}
    </>
  )
}

interface DetailData {
  mandates: Array<{ id: string; gcMandateId: string; state: string; createdAt: Date }>
  payments: Array<{
    id: string
    amountMinor: number
    currency: string
    receivedAt: Date
    confirmedAt: Date | null
    reverted: boolean
    revertedAt: Date | null
    externalId: string
    invoiceExternalId: string | null
  }>
}

function DetailHistory({ data }: { data: DetailData }): JSX.Element {
  return (
    <div className="mt-2 space-y-3">
      <div>
        <div className="text-xs font-medium text-neutral-600">Mandates</div>
        {data.mandates.length === 0 ? (
          <p className="text-sm text-neutral-500">No GoCardless mandates.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {data.mandates.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <Badge tone={MANDATE_TONE[m.state] ?? 'neutral'}>{m.state}</Badge>
                <span className="font-mono text-xs text-neutral-600">{m.gcMandateId}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-xs font-medium text-neutral-600">Payments</div>
        {data.payments.length === 0 ? (
          <p className="text-sm text-neutral-500">No payments recorded.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {data.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono tabular-nums">
                  {formatMoneyMinor(p.amountMinor, p.currency)}
                </span>
                <Badge
                  tone={p.reverted ? 'danger' : p.confirmedAt ? 'success' : 'warn'}
                >
                  {p.reverted ? 'reverted' : p.confirmedAt ? 'confirmed' : 'pending'}
                </Badge>
                <span className="text-xs text-neutral-500">
                  {new Date(p.receivedAt).toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  })}
                </span>
                {p.invoiceExternalId ? (
                  <span className="font-mono text-xs text-neutral-500">
                    Inv {p.invoiceExternalId}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
