// Client island for /call-summaries. Search-first: type a name / email /
// phone and matching customers appear instantly beneath the box — pick one to
// log a call against them. Genuinely new person? "Add a new contact" expands a
// tidy create form, and a de-dup guard still catches a near-duplicate before
// it's created (CLAUDE.md §3 — never auto-merge). The search + create flow is
// the shared ContactFinder (also used by the Log-complaint modal). Once a
// contact is resolved the shared CallSummaryWizard takes over (same VA-vs-self
// flow as the contact page). A recent-summaries queue sits below.

'use client'

import { useState } from 'react'
import Link from 'next/link'

import { CallSummaryWizard } from '@/components/contact/call-summary-wizard'
import { ContactFinder, type ResolvedContact } from '@/components/contact/contact-finder'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { trpc } from '@/lib/trpc/client'

export function CallSummariesWorkspace() {
  const [resolved, setResolved] = useState<ResolvedContact | null>(null)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {resolved ? (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 bg-gradient-to-b from-neutral-50/70 to-white px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar name={resolved.contactName} size={34} />
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                  Logging a call for
                </p>
                <Link
                  href={`/contacts/${resolved.contactId}`}
                  className="block truncate text-sm font-semibold text-neutral-900 hover:text-primary-700 hover:underline"
                >
                  {resolved.contactName}
                </Link>
              </div>
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={() => setResolved(null)}>
              ← Search again
            </Button>
          </div>
          <div className="p-4">
            <CallSummaryWizard
              mode="contact"
              contactId={resolved.contactId}
              contactName={resolved.contactName}
            />
          </div>
        </Card>
      ) : (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Log a call</h2>
          <p className="mt-0.5 text-sm text-neutral-500">
            Search the customer you spoke to, or add a new one.
          </p>
          <div className="mt-3">
            <ContactFinder onResolved={setResolved} createCta="Create & log call →" />
          </div>
        </Card>
      )}

      <RecentSummaries />
    </div>
  )
}

const OUTCOME_LABEL: Record<string, string> = {
  answered: 'Answered',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
}

function RecentSummaries() {
  const [filter, setFilter] = useState<'all' | 'mine'>('all')
  const query = trpc.callSummaries.recent.useQuery({ filter, limit: 30 })
  const rows = query.data ?? []

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-neutral-900">Recent call summaries</h2>
        <div className="flex items-center gap-1">
          {(['all', 'mine'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={
                filter === f
                  ? 'rounded-full bg-primary-600 px-2.5 py-0.5 text-xs font-medium text-white'
                  : 'rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200'
              }
            >
              {f === 'all' ? 'Everyone' : 'Mine'}
            </button>
          ))}
        </div>
      </div>
      {query.isLoading ? (
        <p className="p-4 text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-neutral-600">
          No call summaries yet — log one above and it&apos;ll appear here.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
              <Avatar name={r.contact?.name ?? 'Unlinked'} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-neutral-900">
                  {r.contact ? (
                    <Link href={`/contacts/${r.contact.id}`} className="hover:underline">
                      {r.contact.name}
                    </Link>
                  ) : (
                    'Unlinked'
                  )}
                </span>
                {r.summary ? (
                  <span className="block truncate text-xs text-neutral-500">{r.summary}</span>
                ) : null}
              </span>
              {r.outcome ? (
                <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600">
                  {OUTCOME_LABEL[r.outcome] ?? r.outcome}
                </span>
              ) : null}
              <span className="hidden shrink-0 text-[11px] text-neutral-400 sm:block">
                {r.authorName ? `${r.authorName} · ` : ''}
                {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
                  new Date(r.occurredAt),
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
