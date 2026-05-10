// Payment links list page. CLAUDE.md §8 — every Payment Link sent from the
// CRM should be recoverable from a single index page. Role-gated: anyone who
// can create a payment link can see the list.

import Link from 'next/link'

import { TRPCError } from '@trpc/server'

import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  created: 'Created',
  completed: 'Completed',
  expired: 'Expired',
  cancelled: 'Cancelled',
}

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-900',
  created: 'bg-blue-100 text-blue-900',
  completed: 'bg-green-100 text-green-900',
  expired: 'bg-neutral-100 text-neutral-700',
  cancelled: 'bg-red-100 text-red-900',
}

function formatGbp(minor: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format(minor / 100)
}

export default async function PaymentLinksPage() {
  const caller = await createServerCaller()
  let items: Awaited<ReturnType<typeof caller.finance.paymentLink.list>>['items'] = []
  let forbidden = false
  try {
    const res = await caller.finance.paymentLink.list({ limit: 100 })
    items = res.items
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      forbidden = true
    } else {
      throw err
    }
  }

  if (forbidden) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payment links</h1>
        <p className="mt-2 text-sm text-neutral-600">
          You do not have permission to view payment links.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Payment links</h1>
        <Link href="/finance" className="text-sm text-neutral-700 hover:underline">
          ← Back to finance
        </Link>
      </div>
      <p className="mt-2 text-sm text-neutral-600">
        One-off Stripe Payment Links sent from the CRM. Send a link from a
        Family or Contact page; settled payments reconcile back to the family
        ledger via the originating metadata.
      </p>

      {items.length === 0 ? (
        <div className="mt-6 rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-700">
          No payment links yet. Open a Family or Contact and use{' '}
          <strong>Send payment link</strong> to create one.
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
          {items.map((it) => (
            <li key={it.id} className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      STATUS_TONE[it.status] ?? 'bg-neutral-100 text-neutral-700'
                    }`}
                  >
                    {STATUS_LABEL[it.status] ?? it.status}
                  </span>
                  <span className="font-mono text-xs text-neutral-500">
                    {it.reason}
                  </span>
                </div>
                <div className="mt-1 text-sm text-neutral-900">
                  <Link
                    href={`/contacts/families/${it.familyId}`}
                    className="text-blue-700 hover:underline"
                  >
                    Family {it.familyId}
                  </Link>
                  {it.contactId ? (
                    <>
                      {' · '}
                      <Link
                        href={`/contacts/${it.contactId}`}
                        className="text-blue-700 hover:underline"
                      >
                        Contact {it.contactId}
                      </Link>
                    </>
                  ) : null}
                </div>
                {it.url && (
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block break-all font-mono text-xs text-neutral-600 hover:underline"
                  >
                    {it.url}
                  </a>
                )}
              </div>
              <div className="shrink-0 text-right text-sm">
                <div className="font-mono tabular-nums text-neutral-900">
                  {formatGbp(it.amountMinor)}
                </div>
                <div className="font-mono text-xs text-neutral-500 tabular-nums">
                  {it.createdAt.toISOString().slice(0, 10)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
