// Per-customer payments panel (Slice A). RSC. Renders the payment summary
// tiles + a table of Stripe / GoCardless payments for a Family. Mounted on
// both the Family detail page and the Contact detail page (when the contact
// has a family). CLAUDE.md §6.1, §20 (finance roles only), §26 (RSC, dense,
// plain-English empty states), §19/§29 (money formatted at render only).

import { TRPCError } from '@trpc/server'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

const STATUS_TONE: Record<string, BadgeTone> = {
  paid: 'success',
  failed: 'danger',
  pending: 'warn',
  refunded: 'neutral',
}

const STATUS_LABEL: Record<string, string> = {
  paid: 'Paid',
  failed: 'Failed',
  pending: 'Pending',
  refunded: 'Refunded',
}

const PROVIDER_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  gocardless: 'GoCardless',
  manual: 'Manual',
  unknown: 'Unknown',
}

type Target = { familyId: string } | { contactId: string }

function Tile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'success' | 'danger' | 'warn'
}): JSX.Element {
  const valueColor =
    tone === 'success'
      ? 'text-emerald-700'
      : tone === 'danger'
        ? 'text-red-700'
        : tone === 'warn'
          ? 'text-amber-700'
          : 'text-neutral-900'
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-lg tabular-nums ${valueColor}`}>{value}</div>
    </div>
  )
}

export async function PaymentsPanel({ target }: { target: Target }): Promise<JSX.Element> {
  const caller = await createServerCaller()

  let summaryRes: Awaited<ReturnType<typeof caller.finance.customerPayments.summary>>
  let listRes: Awaited<ReturnType<typeof caller.finance.customerPayments.list>>
  try {
    ;[summaryRes, listRes] = await Promise.all([
      caller.finance.customerPayments.summary(target),
      caller.finance.customerPayments.list(target),
    ])
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      return (
        <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
          You need the Manager, Senior Manager, or CEO role to view payments.
        </p>
      )
    }
    throw err
  }

  // Contact without a family — no billing relationship yet.
  if (summaryRes.familyId === null) {
    return (
      <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
        No billing on this contact yet — link it to a family to see payments.
      </p>
    )
  }

  const { summary } = summaryRes
  const items = listRes.items

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Paid" value={formatMoneyMinor(summary?.totalPaidMinor ?? 0)} tone="success" />
        <Tile
          label="Refunded"
          value={formatMoneyMinor(summary?.totalRefundedMinor ?? 0)}
        />
        <Tile
          label="Failed"
          value={formatMoneyMinor(summary?.totalFailedMinor ?? 0)}
          tone="danger"
        />
        <Tile
          label="Open invoiced"
          value={formatMoneyMinor(summary?.openInvoiceMinor ?? 0)}
          tone={(summary?.openInvoiceMinor ?? 0) > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-600">
        <span>
          Active mandates:{' '}
          <span className="font-mono tabular-nums">{summary?.activeMandates ?? 0}</span>
        </span>
        <span>
          Active subscriptions:{' '}
          <span className="font-mono tabular-nums">{summary?.activeSubscriptions ?? 0}</span>
        </span>
        {summary?.lastPaymentAt ? (
          <span>Last payment {formatRelativeTime(new Date(summary.lastPaymentAt))}</span>
        ) : null}
      </div>

      <div className="rounded-md border border-neutral-200 bg-white">
        {items.length === 0 ? (
          <p className="p-4 text-sm text-neutral-600">
            No payments recorded yet — Stripe and GoCardless payments will appear
            here as they settle.
          </p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Provider</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
                <Th>Date</Th>
                <Th>Related</Th>
              </Tr>
            </Thead>
            <Tbody>
              {items.map((p) => (
                <Tr key={p.id}>
                  <Td>
                    <Badge tone={p.provider === 'stripe' ? 'info' : 'accent'}>
                      {PROVIDER_LABEL[p.provider] ?? p.provider}
                    </Badge>
                  </Td>
                  <Td className="font-mono tabular-nums">
                    {formatMoneyMinor(p.amountMinor, p.currency)}
                    {p.refundedMinor > 0 ? (
                      <span className="ml-1 text-xs text-neutral-500">
                        (−{formatMoneyMinor(p.refundedMinor, p.currency)} refunded)
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>
                      {STATUS_LABEL[p.status] ?? p.status}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-neutral-600">
                    <time dateTime={new Date(p.occurredAt).toISOString()}>
                      {new Date(p.occurredAt).toLocaleDateString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </time>
                  </Td>
                  <Td className="text-xs text-neutral-600">
                    {p.invoice ? (
                      <span className="font-mono">Inv {p.invoice.externalId}</span>
                    ) : p.relatedSubscription ? (
                      <span className="font-mono">Sub {p.relatedSubscription.stripeId}</span>
                    ) : p.relatedMandate ? (
                      <span className="font-mono">
                        Mandate {p.relatedMandate.gcMandateId} ({p.relatedMandate.state})
                      </span>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>
    </div>
  )
}
