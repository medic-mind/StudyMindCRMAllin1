// Family detail page. RSC. CLAUDE.md §6.1, §26.
//
// Displays the Family's billing party, lifecycle state, members, open
// reconciliation discrepancies, and a recent timeline slice.

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { resolveStageColor } from '@/app/(app)/pipeline/stage-color'
import { ChangeBillingContactButton } from '@/components/contact/ChangeBillingContactButton'
import { FamilyDirectDebitPanel } from '@/components/finance/gocardless/FamilyDirectDebitPanel'
import { PaymentsPanel } from '@/components/finance/PaymentsPanel'
import { InvoicesPanel } from '@/components/invoices/InvoicesPanel'
import { ReconcileNowButton } from '@/components/finance/ReconcileNowButton'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

const DISCREPANCY_LABELS: Record<string, string> = {
  hours_mismatch: 'Hours mismatch',
  payment_unallocated: 'Unallocated payment',
  late_failure: 'Late failure',
  late_failure_pending_action: 'Late failure — action needed',
  churned_with_active_subscription: 'Churned but subscription active',
  la_family_with_card_subscription: 'LA family on card subscription',
  direct_debit_default: 'Direct Debit default',
  direct_debit_plan_shortfall: 'Plan cancelled/underpaid',
  direct_debit_plan_arrears: 'Plan behind schedule',
  other: 'Other',
}

function discrepancyLabel(category: string): string {
  return DISCREPANCY_LABELS[category] ?? category
}

function discrepancyToneClass(category: string): string {
  if (category === 'direct_debit_default' || category === 'direct_debit_plan_shortfall') {
    return 'bg-red-100 text-red-800'
  }
  if (category === 'direct_debit_plan_arrears' || category.startsWith('late_failure')) {
    return 'bg-amber-100 text-amber-800'
  }
  return 'bg-neutral-200 text-neutral-700'
}

export default async function FamilyDetailPage({
  params,
}: {
  params: Promise<{ familyId: string }>
}) {
  const { familyId } = await params
  const caller = await createServerCaller()
  const data = await caller.family.getDetail({ id: familyId }).catch((e) => {
    if (typeof e === 'object' && e && 'code' in e && (e as { code: string }).code === 'NOT_FOUND') {
      notFound()
    }
    throw e
  })

  const billingName =
    data.billingContact?.name ?? (data.name ?? `Family ${data.id.slice(-6)}`)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.name ?? billingName}
          </h1>
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-neutral-600">
            <span>
              {data.billingParty === 'local_authority'
                ? 'Billed to a Local Authority'
                : 'Billed to family'}
            </span>
            <span>·</span>
            {data.stage ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: resolveStageColor(data.stage.color) }}
                  aria-hidden
                />
                <span className="font-medium text-neutral-800">
                  {data.stage.name}
                </span>
                {data.stage.isClosed ? (
                  <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] uppercase text-neutral-700">
                    Closed
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-amber-700">Unassigned stage</span>
            )}
            {data.churnScore !== null ? (
              <>
                <span>·</span>
                <span>
                  Churn score:{' '}
                  <span className="font-mono">
                    {data.churnScore.toFixed(2)}
                  </span>
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/contacts/families/${data.id}/timeline`}
            className="text-sm text-neutral-700 hover:underline"
          >
            Timeline →
          </Link>
          <Link href="/contacts" className="text-sm text-neutral-600 underline">
            Back to contacts
          </Link>
        </div>
      </div>

      <section className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
        <ChangeBillingContactButton
          familyId={data.id}
          members={data.members.map((m) => ({
            contactId: m.contactId,
            name: m.name,
            kind: m.kind as string,
            isMinor: m.isMinor,
          }))}
          currentBillingContactId={data.billingContact?.id ?? null}
        />
        <ReconcileNowButton familyId={data.id} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Members
        </h2>
        <div className="mt-2 rounded-md border border-neutral-200 bg-white">
          {data.members.length === 0 ? (
            <p className="p-4 text-sm text-neutral-600">
              No members linked yet — link a Contact to this Family to start.
            </p>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Kind</Th>
                  <Th>Role</Th>
                  <Th>Minor</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.members.map((m) => (
                  <Tr key={m.contactId}>
                    <Td>
                      <Link
                        href={`/contacts/${m.contactId}`}
                        className="text-primary-700 hover:underline"
                      >
                        {m.name || 'Unnamed contact'}
                      </Link>
                    </Td>
                    <Td className="font-mono text-xs">{m.kind}</Td>
                    <Td className="text-xs">{m.role}</Td>
                    <Td>{m.isMinor ? 'yes' : 'no'}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Direct Debit
        </h2>
        <div className="mt-2 rounded-md border border-neutral-200 bg-white">
          <FamilyDirectDebitPanel familyId={data.id} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Payments
        </h2>
        <div className="mt-2">
          <PaymentsPanel target={{ familyId: data.id }} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Uploaded invoices
        </h2>
        <div className="mt-2">
          <InvoicesPanel target={{ kind: 'family', familyId: data.id }} />
        </div>
      </section>

      <section>
        <h2 className="flex items-center justify-between text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          <span>
            Open reconciliation discrepancies
            <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-xs tabular-nums normal-case text-neutral-700">
              {data.openDiscrepancies.length}
            </span>
          </span>
        </h2>
        <div className="mt-2 rounded-md border border-neutral-200 bg-white">
          {data.openDiscrepancies.length === 0 ? (
            <p className="p-4 text-sm text-neutral-600">No open discrepancies.</p>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Issue</Th>
                  <Th>Detail</Th>
                  <Th>Opened</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.openDiscrepancies.map((d) => (
                  <Tr key={d.id}>
                    <Td>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${discrepancyToneClass(d.category)}`}
                      >
                        {discrepancyLabel(d.category)}
                      </span>
                    </Td>
                    <Td className="text-xs text-neutral-700">{d.summary}</Td>
                    <Td className="text-xs whitespace-nowrap">
                      {new Date(d.createdAt).toLocaleString('en-GB', { timeZone: 'Europe/London' })}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Recent timeline
        </h2>
        <div className="mt-2 rounded-md border border-neutral-200 bg-white">
          {data.recentInteractions.length === 0 ? (
            <p className="p-4 text-sm text-neutral-600">
              No interactions yet — start by sending a message or logging a call.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {data.recentInteractions.map((i) => (
                <li key={i.id} className="p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-neutral-500">{i.type}</span>
                    <span className="text-xs text-neutral-500">
                      {new Date(i.occurredAt).toLocaleString('en-GB', { timeZone: 'Europe/London' })}
                    </span>
                  </div>
                  {i.summary ? (
                    <p className="mt-1 text-neutral-800">{i.summary}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
