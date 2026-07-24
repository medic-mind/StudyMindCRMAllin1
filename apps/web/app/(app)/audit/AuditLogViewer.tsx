// Org-wide audit log browser. Filters by activity type + date range and pages
// through audit.list. Read-only; the server enforces `audit.read`.

'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'

import { Card } from '@/components/ui/card'
import { trpc } from '@/lib/trpc/client'
import type { AuditCategory } from '@/lib/view-models/audit-activity'

// Curated activity buckets → the concrete action names the server filters on.
// 'all' passes no filter. Keeps the compliance surface readable without
// exposing raw dotted action strings.
const TYPE_FILTERS: Array<{ key: string; label: string; actions?: string[] }> = [
  { key: 'all', label: 'All activity' },
  { key: 'views', label: 'Record views', actions: ['contact.viewed', 'contact.read_minor'] },
  {
    key: 'changes',
    label: 'Record changes',
    actions: [
      'contact.created',
      'contact.updated',
      'contact.merged',
      'contact.deleted',
      'contact.bulk_soft_deleted',
      'contact.restored',
    ],
  },
  {
    key: 'signins',
    label: 'Sign-ins',
    actions: [
      'auth.signin_succeeded',
      'auth.signin_failed',
      'auth.account_locked',
      'auth.totp_failed',
      'auth.recovery_code_used',
    ],
  },
  { key: 'exports', label: 'Exports', actions: ['contact.exported', 'account.exported'] },
  { key: 'dsar', label: 'DSAR exports', actions: ['dsar.exported'] },
]

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

function toStartOfDay(value: string): Date | undefined {
  if (!value) return undefined
  const d = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? undefined : d
}
function toEndOfDay(value: string): Date | undefined {
  if (!value) return undefined
  const d = new Date(`${value}T23:59:59.999Z`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export function AuditLogViewer() {
  const [typeKey, setTypeKey] = useState('all')
  const [sinceStr, setSinceStr] = useState('')
  const [untilStr, setUntilStr] = useState('')
  const [cursor, setCursor] = useState<{ occurredAt: Date; id: string } | null>(null)

  const actions = useMemo(
    () => TYPE_FILTERS.find((t) => t.key === typeKey)?.actions,
    [typeKey],
  )

  const query = trpc.audit.list.useQuery(
    {
      actions,
      since: toStartOfDay(sinceStr),
      until: toEndOfDay(untilStr),
      cursor,
      limit: 40,
    },
    { placeholderData: (prev) => prev },
  )

  function resetPaging<T>(setter: (v: T) => void) {
    return (v: T) => {
      setCursor(null)
      setter(v)
    }
  }

  const items = query.data?.items ?? []

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1.5">
          {TYPE_FILTERS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => resetPaging(setTypeKey)(t.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
                typeKey === t.key
                  ? 'bg-primary-600 text-white ring-primary-600'
                  : 'bg-white text-neutral-700 ring-neutral-200 hover:bg-neutral-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="flex flex-col text-xs font-medium text-neutral-500">
          From
          <input
            type="date"
            value={sinceStr}
            onChange={(e) => resetPaging(setSinceStr)(e.target.value)}
            className="mt-1 rounded-md border border-neutral-200 px-2 py-1 text-sm text-neutral-800"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-neutral-500">
          To
          <input
            type="date"
            value={untilStr}
            onChange={(e) => resetPaging(setUntilStr)(e.target.value)}
            className="mt-1 rounded-md border border-neutral-200 px-2 py-1 text-sm text-neutral-800"
          />
        </label>
      </div>

      <Card className="overflow-hidden">
        {query.isLoading ? (
          <p className="p-4 text-sm text-neutral-500">Loading audit log…</p>
        ) : query.isError ? (
          <p className="p-4 text-sm text-neutral-500">
            You do not have permission to view the audit log.
          </p>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-neutral-600">No activity for this filter.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {items.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-sm">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${CATEGORY_CHIP[row.category]}`}
                >
                  {row.label}
                </span>
                <span className="font-medium text-neutral-900">{row.actorLabel}</span>
                <span className="text-neutral-500">
                  {row.targetType === 'Contact' && row.targetLabel ? (
                    <>
                      {' · '}
                      <Link
                        href={`/contacts/${row.targetId}`}
                        className="text-primary-700 hover:underline"
                      >
                        {row.targetLabel}
                      </Link>
                    </>
                  ) : row.targetType !== 'Export' && row.targetType !== 'User' ? (
                    <span className="text-neutral-400"> · {row.targetType}</span>
                  ) : null}
                </span>
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
          </ul>
        )}
      </Card>

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
