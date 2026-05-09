// DSL inbox — list of open SafeguardingFlags. CLAUDE.md §42.2.
// Server component; the triage dialog is a client island.

import Link from 'next/link'

import { createServerCaller } from '@/lib/trpc/server'

import { TriageDialogTrigger } from './TriageDialogTrigger'

const URGENCY_SLA_MS: Record<string, number> = {
  routine: 4 * 60 * 60 * 1000,
  urgent: 60 * 60 * 1000,
  immediate: 15 * 60 * 1000,
}

function formatRemaining(createdAt: Date, urgency: string): string {
  const sla = URGENCY_SLA_MS[urgency] ?? URGENCY_SLA_MS['routine']
  const ms = sla! - (Date.now() - createdAt.getTime())
  if (ms <= 0) return 'BREACHED'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

export default async function DslInboxPage() {
  const caller = await createServerCaller()
  const flags = await caller.safeguarding.list()

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Safeguarding inbox</h1>
      <p className="mt-1 text-sm text-neutral-600">
        DSL-only. Sorted by urgency then recency. CLAUDE.md §42.
      </p>
      <table className="mt-6 w-full text-left text-sm">
        <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-600">
          <tr>
            <th className="py-2">Contact</th>
            <th>State</th>
            <th>Urgency</th>
            <th>SLA</th>
            <th>Raised</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {flags.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-neutral-600">
                No open concerns. New concerns appear here as soon as an agent raises one.
              </td>
            </tr>
          )}
          {flags.map((f) => (
            <tr key={f.id} className="border-b border-neutral-100">
              <td className="py-2">
                <Link href={`/contacts/${f.contactId}`} className="text-blue-700 hover:underline">
                  {f.contactName || f.contactId}
                </Link>
              </td>
              <td>{f.state}</td>
              <td>{f.urgency}</td>
              <td className="font-mono">{formatRemaining(f.createdAt, f.urgency)}</td>
              <td>{f.createdAt.toLocaleString('en-GB')}</td>
              <td>
                <TriageDialogTrigger flagId={f.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
