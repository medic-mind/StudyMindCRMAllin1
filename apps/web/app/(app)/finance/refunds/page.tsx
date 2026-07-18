// Refunds page. CLAUDE.md §8 — refunds always go through the audited
// outbound flow with deterministic idempotency keys. This page is the
// read-only list; the issue-refund dialog lives at /finance/refunds/new.

import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'

import { TRPCError } from '@trpc/server'

import { createServerCaller } from '@/lib/trpc/server'
import { paymentStatusTone } from '@/lib/ui/status-tone'

interface SP {
  familyId?: string
  cursorId?: string
  cursorAt?: string
}

function formatGBP(minor: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100)
}

export default async function RefundsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const caller = await createServerCaller()
  const cursor =
    sp.cursorId && sp.cursorAt
      ? { id: sp.cursorId, createdAt: new Date(sp.cursorAt) }
      : undefined
  let items: Awaited<ReturnType<typeof caller.finance.refund.list>>['items'] = []
  let nextCursor: { id: string; createdAt: Date } | null = null
  let forbidden = false
  try {
    const res = await caller.finance.refund.list({
      cursor,
      limit: 25,
      familyId: sp.familyId,
    })
    items = res.items
    nextCursor = res.nextCursor
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
        <h1 className="text-2xl font-semibold tracking-tight">Refunds</h1>
        <p className="mt-2 text-sm text-neutral-600">
          You need the Manager, Senior Manager, or CEO role to view refunds.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Refunds</h1>
        <Link href="/finance/refunds/new">
          <Button>Issue refund</Button>
        </Link>
      </div>
      <p className="mt-2 text-sm text-neutral-600">
        Every refund carries a deterministic idempotency key and lands in the
        audit log. Failed refunds stay in <code>pending_review</code> for
        finance to retry manually — never automatic.
      </p>

      <div className="mt-6 rounded-md border border-neutral-200 bg-white">
        {items.length === 0 ? (
          <div className="p-6 text-sm text-neutral-600">
            No refunds in scope. Issue one with the button above, or pass a
            <code className="mx-1">?familyId=...</code> to filter.
          </div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Created</Th>
                <Th>Family</Th>
                <Th>Charge</Th>
                <Th>Amount</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
              </Tr>
            </Thead>
            <Tbody>
              {items.map((r) => (
                <Tr key={r.id}>
                  <Td className="font-mono text-xs tabular-nums text-neutral-600">
                    {r.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </Td>
                  <Td>
                    <Link
                      href={`/contacts/families/${r.familyId}`}
                      className="text-sm text-neutral-700 hover:underline"
                    >
                      {r.familyId}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs">{r.chargeId}</Td>
                  <Td className="font-mono tabular-nums">{formatGBP(r.amountMinor)}</Td>
                  <Td className="text-sm text-neutral-700">{r.reasonCode}</Td>
                  <Td>
                    <Badge tone={paymentStatusTone(r.status)}>{r.status}</Badge>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>

      {nextCursor ? (
        <div className="mt-4">
          <Link
            href={{
              pathname: '/finance/refunds',
              query: {
                ...(sp.familyId ? { familyId: sp.familyId } : {}),
                cursorId: nextCursor.id,
                cursorAt: nextCursor.createdAt.toISOString(),
              },
            }}
            className="text-sm text-neutral-700 hover:underline"
          >
            Next page →
          </Link>
        </div>
      ) : null}
    </div>
  )
}
