// Contact-field suggestions review queue (ADR 0020 Phase 6c).
// CLAUDE.md §3 — humans confirm; no silent merge. Manager+ accepts/rejects.

import Link from 'next/link'
import { TRPCError } from '@trpc/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

import { SuggestionActions } from './SuggestionActions'

const FIELD_LABEL: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phoneE164: 'Phone',
}

type Status = 'pending' | 'accepted' | 'rejected'

const STATUSES: ReadonlyArray<{ value: Status; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
]

function parseStatus(raw: string | string[] | undefined): Status {
  const v = Array.isArray(raw) ? raw[0] : raw
  return STATUSES.some((s) => s.value === v) ? (v as Status) : 'pending'
}

export default async function SuggestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>
}) {
  const params = await searchParams
  const status = parseStatus(params.status)
  const caller = await createServerCaller()
  type Item = Awaited<ReturnType<typeof caller.contactSuggestion.list>>[number]
  let items: Item[] = []
  let forbidden = false
  try {
    items = await caller.contactSuggestion.list({ status, limit: 100 })
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') forbidden = true
    else throw err
  }

  if (forbidden) {
    return (
      <>
        <PageHeader title="Suggestions" subtitle="Inbox" />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need a staff role to review suggestions.
          </p>
        </PageBody>
      </>
    )
  }

  const now = new Date()

  return (
    <>
      <PageHeader
        title="Contact-field suggestions"
        subtitle="Inbound edits from Trengo (and other channels) are surfaced here for human confirmation — we never silently overwrite a contact."
      />
      <PageBody>
        {/* Sub-nav: the customer inbox + this field-edit review queue. */}
        <nav
          aria-label="Inbox view"
          className="mb-3 flex flex-wrap items-center gap-1"
        >
          <Link
            href="/inbox"
            className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            Conversations
          </Link>
          <Link
            href="/inbox/suggestions"
            aria-current="page"
            className="rounded-md bg-primary-600 px-2.5 py-1 text-xs font-medium text-white"
          >
            Suggestions
          </Link>
        </nav>

        <nav
          aria-label="Suggestion status"
          className="mb-3 flex flex-wrap items-center gap-1"
        >
          {STATUSES.map((s) => {
            const href = s.value === 'pending' ? '/inbox/suggestions' : `/inbox/suggestions?status=${s.value}`
            const isActive = status === s.value
            return (
              <Link
                key={s.value}
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={
                  isActive
                    ? 'rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white'
                    : 'rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50'
                }
              >
                {s.label}
              </Link>
            )
          })}
        </nav>

        {items.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-sm">
            <p className="text-sm font-medium text-neutral-700">
              {status === 'pending'
                ? 'No suggestions to review.'
                : status === 'accepted'
                  ? 'No accepted suggestions yet.'
                  : 'No rejected suggestions yet.'}
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              When Trengo sends a contact-update event with a value that
              differs from the CRM, it lands here for confirmation.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white shadow-sm">
            {items.map((s) => {
              const href = `/contacts/${s.contactId}`
              return (
                <li key={s.id} className="p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge tone="neutral">
                          {FIELD_LABEL[s.field] ?? s.field}
                        </Badge>
                        <Link
                          href={href}
                          className="truncate font-medium text-neutral-900 hover:underline"
                        >
                          {s.contactName ?? 'Unknown contact'}
                        </Link>
                        <Badge tone="neutral">{s.source}</Badge>
                      </div>
                      <div className="mt-1 grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto,1fr]">
                        <span className="text-xs uppercase tracking-wide text-neutral-500">
                          Current
                        </span>
                        <span className="font-mono text-neutral-700">
                          {s.currentValue ?? '—'}
                        </span>
                        <span className="text-xs uppercase tracking-wide text-neutral-500">
                          Proposed
                        </span>
                        <span className="font-mono text-primary-800">
                          {s.proposedValue ?? '—'}
                        </span>
                      </div>
                    </div>
                    <time
                      className="shrink-0 font-mono text-xs tabular-nums text-neutral-500"
                      dateTime={s.createdAt.toISOString()}
                    >
                      {formatRelativeTime(s.createdAt, now)}
                    </time>
                  </div>
                  {s.status === 'pending' ? (
                    <div className="mt-2">
                      <SuggestionActions suggestionId={s.id} />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </PageBody>
    </>
  )
}
