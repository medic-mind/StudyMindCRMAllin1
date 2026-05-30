'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { trpc } from '@/lib/trpc/client'

type StatusKey =
  | 'all'
  | 'received'
  | 'classified'
  | 'needs_triage'
  | 'onboarded'
  | 'reenquiry'
  | 'dismissed'

const STATUS_TABS: { key: StatusKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs_triage', label: 'Needs triage' },
  { key: 'onboarded', label: 'Onboarded' },
  { key: 'reenquiry', label: 'Re-enquiry' },
  { key: 'received', label: 'New' },
  { key: 'dismissed', label: 'Dismissed' },
]

interface Props {
  initialStats: { total: number; byStatus: Record<string, number> }
  canWrite: boolean
}

function scoreTone(score: number | null): 'success' | 'warn' | 'neutral' {
  if (score == null) return 'neutral'
  if (score >= 70) return 'success'
  if (score >= 40) return 'warn'
  return 'neutral'
}

function statusTone(status: string): 'success' | 'warn' | 'neutral' | 'danger' {
  switch (status) {
    case 'onboarded':
      return 'success'
    case 'reenquiry':
      return 'success'
    case 'needs_triage':
      return 'warn'
    case 'dismissed':
      return 'danger'
    default:
      return 'neutral'
  }
}

function timeAgo(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const min = Math.floor((Date.now() - date.getTime()) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function BrandChip({ brand }: { brand: { name: string; color: string | null } | null }) {
  if (!brand) return <span className="text-neutral-400">—</span>
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: brand.color ?? '#9333ea' }}
        aria-hidden
      />
      <span className="text-neutral-800">{brand.name}</span>
    </span>
  )
}

export function LeadsTray({ initialStats, canWrite }: Props) {
  const [status, setStatus] = useState<StatusKey>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const utils = trpc.useUtils()
  const stats = trpc.lead.stats.useQuery(undefined, { initialData: initialStats })
  const list = trpc.lead.list.useQuery({ status, search: search || undefined, limit: 50 })
  const detail = trpc.lead.get.useQuery({ id: selectedId ?? '' }, { enabled: Boolean(selectedId) })

  const dismiss = trpc.lead.dismiss.useMutation({
    onSuccess: async () => {
      toast.success('Lead dismissed')
      await Promise.all([
        utils.lead.list.invalidate(),
        utils.lead.stats.invalidate(),
        utils.lead.get.invalidate(),
      ])
    },
    onError: (e) => toast.error(e.message),
  })
  const reclassify = trpc.lead.reclassify.useMutation({
    onSuccess: (r) => {
      toast.success(
        r.reclassified ? 'Re-queued for classification' : 'Already onboarded — left as is',
      )
      void utils.lead.get.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })

  const items = list.data?.items ?? []
  const d = detail.data
  const cls = (d?.classification ?? null) as {
    reasons?: string[]
    ai?: { summary?: string; intent?: string; urgency?: string } | null
  } | null

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {STATUS_TABS.map((t) => {
            const active = status === t.key
            const count = t.key === 'all' ? stats.data?.total : stats.data?.byStatus[t.key]
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setStatus(t.key)}
                className={
                  active
                    ? 'rounded-full bg-primary-700 px-3 py-1 text-xs font-medium text-white'
                    : 'rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-200'
                }
              >
                {t.label}
                {count != null ? (
                  <span className="ml-1 tabular-nums opacity-70">{count}</span>
                ) : null}
              </button>
            )
          })}
        </div>
        <div className="ml-auto w-56">
          <Input
            placeholder="Search name, email, phone, domain…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* List */}
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
          {items.length === 0 ? (
            <p className="p-6 text-sm text-neutral-600">
              {list.isLoading
                ? 'Loading leads…'
                : 'No leads here yet. Paste your /api/leads webhook URL into Contact Form 7 (Settings → Integrations → Lead webhook) and submit a test enquiry — it will appear here, classified and routed to the pipeline.'}
            </p>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Enquirer</Th>
                  <Th>Brand</Th>
                  <Th>Interest</Th>
                  <Th>Score</Th>
                  <Th>Status</Th>
                  <Th>When</Th>
                </Tr>
              </Thead>
              <Tbody>
                {items.map((l) => (
                  <Tr
                    key={l.id}
                    className={
                      selectedId === l.id
                        ? 'cursor-pointer bg-primary-50'
                        : 'cursor-pointer hover:bg-neutral-50'
                    }
                    onClick={() => setSelectedId(l.id)}
                  >
                    <Td>
                      <div className="font-medium text-neutral-900">{l.name ?? 'Unnamed'}</div>
                      <div className="text-xs text-neutral-500">{l.email ?? l.phone ?? '—'}</div>
                    </Td>
                    <Td>
                      <BrandChip brand={l.brand} />
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {l.categories.slice(0, 3).map((c) => (
                          <span
                            key={c}
                            className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-700"
                          >
                            {c}
                          </span>
                        ))}
                        {l.categories.length === 0 ? (
                          <span className="text-neutral-400">—</span>
                        ) : null}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={scoreTone(l.score)}>{l.score ?? '—'}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={statusTone(l.status)}>{l.status.replace('_', ' ')}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-neutral-500">
                      {timeAgo(l.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </div>

        {/* Detail */}
        <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
          {!selectedId ? (
            <p className="text-sm text-neutral-500">
              Select a lead to see its classification, landing context and raw payload.
            </p>
          ) : detail.isLoading || !d ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : (
            <div className="space-y-4 text-sm">
              <div>
                <div className="text-base font-semibold text-neutral-900">
                  {d.name ?? 'Unnamed enquirer'}
                </div>
                <div className="text-xs text-neutral-500">
                  {d.email ?? '—'} · {d.phone ?? '—'}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <BrandChip brand={d.brand} />
                <Badge tone={scoreTone(d.score)}>Score {d.score ?? '—'}</Badge>
                <Badge tone={statusTone(d.status)}>{d.status.replace('_', ' ')}</Badge>
              </div>

              {d.categories.length > 0 ? (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Categories
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {d.categories.map((c) => (
                      <span
                        key={c}
                        className="rounded bg-primary-50 px-1.5 py-0.5 text-[11px] text-primary-800"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {d.productTags.length > 0 ? (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Products
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {d.productTags.map((p) => (
                      <span
                        key={p}
                        className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-700"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {cls?.ai?.summary ? (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    AI summary
                  </div>
                  <p className="mt-1 text-neutral-700">{cls.ai.summary}</p>
                  <div className="mt-1 text-xs text-neutral-500">
                    Intent: {cls.ai.intent ?? '—'} · Urgency: {cls.ai.urgency ?? '—'}
                  </div>
                </div>
              ) : null}

              {cls?.reasons && cls.reasons.length > 0 ? (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Why this classification
                  </div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-neutral-600">
                    {cls.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Landing
                </div>
                <div className="mt-1 break-all text-xs text-neutral-600">
                  {d.landingUrl ?? d.landingDomain ?? d.sourceLabel}
                </div>
              </div>

              <details className="rounded border border-neutral-200">
                <summary className="cursor-pointer px-2 py-1 text-xs font-medium text-neutral-700">
                  Raw payload
                </summary>
                <pre className="max-h-64 overflow-auto bg-neutral-50 p-2 text-[11px] leading-snug text-neutral-700">
                  {JSON.stringify(d.rawPayload, null, 2)}
                </pre>
              </details>

              <div className="flex flex-wrap gap-2 pt-1">
                {d.convertedToContactId ? (
                  <Link
                    href={`/contacts/${d.convertedToContactId}`}
                    className="rounded-md bg-primary-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-800"
                  >
                    Open contact
                  </Link>
                ) : null}
                {canWrite ? (
                  <>
                    <Button
                      type="button"
                      onClick={() => reclassify.mutate({ id: d.id })}
                      disabled={reclassify.isPending}
                    >
                      Reclassify
                    </Button>
                    {d.status !== 'dismissed' ? (
                      <Button
                        type="button"
                        onClick={() => dismiss.mutate({ id: d.id })}
                        disabled={dismiss.isPending}
                      >
                        Dismiss
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
