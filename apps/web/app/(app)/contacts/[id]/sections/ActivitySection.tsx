// Per-record access & change log (compliance activity viewer).
// Renders "who viewed, added, edited, or deleted this record, and when" from
// the append-only AuditLogEntry table via audit.forTarget. Only mounted for
// users who hold `audit.read` (gated in the RSC page), but it also degrades
// gracefully if the query is ever denied. CLAUDE.md §20, §27.

'use client'

import { useState } from 'react'

import { trpc } from '@/lib/trpc/client'
import type { AuditCategory } from '@/lib/view-models/audit-activity'

interface Props {
  /** The audited entity type — 'Contact' or 'BusinessAccount'. */
  targetType: string
  targetId: string
}

const CATEGORY_CHIP: Record<AuditCategory, string> = {
  view: 'bg-neutral-100 text-neutral-700 ring-neutral-200',
  create: 'bg-green-50 text-green-800 ring-green-200',
  update: 'bg-primary-50 text-primary-800 ring-primary-200',
  delete: 'bg-red-50 text-red-800 ring-red-200',
  merge: 'bg-amber-50 text-amber-800 ring-amber-200',
  auth: 'bg-neutral-100 text-neutral-700 ring-neutral-200',
  export: 'bg-amber-50 text-amber-800 ring-amber-200',
  'export.dsar': 'bg-amber-50 text-amber-800 ring-amber-200',
  other: 'bg-neutral-100 text-neutral-700 ring-neutral-200',
}

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(new Date(iso))
}

export function ActivitySection({ targetType, targetId }: Props) {
  const [cursor, setCursor] = useState<{ occurredAt: Date; id: string } | null>(null)
  const query = trpc.audit.forTarget.useQuery(
    { targetType, targetId, limit: 30, cursor },
    { placeholderData: (prev) => prev },
  )

  if (query.isLoading) {
    return <p className="text-sm text-neutral-500">Loading activity…</p>
  }
  if (query.isError) {
    return (
      <p className="text-sm text-neutral-500">
        You do not have permission to view this record&rsquo;s activity log.
      </p>
    )
  }

  const items = query.data?.items ?? []
  if (items.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        No recorded activity yet. Every view, edit, and deletion of this record is logged here.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500">
        Every time a staff member opens, edits, or deletes this record it is recorded below —
        an append-only trail for accountability and audit.
      </p>
      <ol className="space-y-1.5">
        {items.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm"
          >
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${CATEGORY_CHIP[row.category]}`}
            >
              {row.label}
            </span>
            <span className="font-medium text-neutral-900">{row.actorLabel}</span>
            {row.changedFields.length > 0 && (
              <span className="text-xs text-neutral-500">
                changed {row.changedFields.slice(0, 6).join(', ')}
                {row.changedFields.length > 6 ? '…' : ''}
              </span>
            )}
            <span className="ml-auto font-mono text-xs tabular-nums text-neutral-500">
              {formatWhen(row.occurredAt)}
            </span>
          </li>
        ))}
      </ol>
      {query.data?.nextCursor && (
        <button
          type="button"
          onClick={() => setCursor(query.data!.nextCursor)}
          className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
        >
          Show older activity
        </button>
      )}
    </div>
  )
}
