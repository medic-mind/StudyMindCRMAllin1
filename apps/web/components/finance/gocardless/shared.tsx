'use client'

// Shared bits for the Direct Debit workspace (ADR 0038): status tones, date
// formatting, and the customer → mandate picker used by the plan and one-off
// payment forms.

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

export const SUBSCRIPTION_TONE: Record<string, BadgeTone> = {
  active: 'success',
  paused: 'warn',
  pending_customer_approval: 'info',
  customer_approval_denied: 'danger',
  cancelled: 'danger',
  finished: 'neutral',
  unknown: 'neutral',
}

export const PAYMENT_TONE: Record<string, BadgeTone> = {
  confirmed: 'success',
  paid_out: 'success',
  submitted: 'info',
  pending_submission: 'info',
  pending_customer_approval: 'info',
  failed: 'danger',
  charged_back: 'danger',
  customer_approval_denied: 'danger',
  cancelled: 'neutral',
  unknown: 'neutral',
}

export const MANDATE_TONE: Record<string, BadgeTone> = {
  active: 'success',
  submitted: 'info',
  pending_submission: 'info',
  failed: 'danger',
  cancelled: 'danger',
  expired: 'warn',
  replaced: 'neutral',
}

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(d.getTime()) ? '—' : DATE.format(d)
}

export function statusLabel(value: string): string {
  return value.replaceAll('_', ' ')
}

/**
 * URL-driven list state for the workspace tables (CLAUDE.md §26 — filters
 * live in the URL so a filtered+sorted+paged view is shareable). `set`
 * resets `page` so a filter change never strands you on an empty page.
 */
export function useListParams() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const get = (key: string, fallback = ''): string => searchParams.get(key) ?? fallback

  const set = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') params.delete(key)
      else params.set(key, value)
    }
    params.delete('page')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return { get, set, searchParams }
}

/** Parse list paging/sorting URL params with sane bounds. */
export function readPageSort(
  get: (key: string, fallback?: string) => string,
  defaults: { sortBy: string; pageSize?: number },
) {
  const page = Math.max(1, Number(get('page')) || 1)
  const rawSize = Number(get('pageSize')) || defaults.pageSize || 50
  const pageSize = Math.min(100, Math.max(1, rawSize))
  const sortBy = get('sortBy', defaults.sortBy) || defaults.sortBy
  const sortDir: 'asc' | 'desc' = get('sortDir') === 'asc' ? 'asc' : 'desc'
  return { page, pageSize, sortBy, sortDir }
}

/** Parse a YYYY-MM-DD URL param into a Date (UTC midnight); else undefined. */
export function readDateParam(value: string, endOfDay = false): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const parsed = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/** Parse a £ URL param ("12.50") into integer pence; else undefined. */
export function readPoundsParam(value: string): number | undefined {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return undefined
  const minor = Math.round(Number(value) * 100)
  return Number.isFinite(minor) ? minor : undefined
}

/**
 * Debounced URL-writing input — the building block for the date / amount
 * range filters on the workspace tables.
 */
export function ParamInput({
  param,
  type = 'text',
  placeholder,
  label,
  width = 'w-28',
}: {
  param: string
  type?: 'text' | 'date'
  placeholder?: string
  label: string
  width?: string
}) {
  const { get, set } = useListParams()
  const urlValue = get(param)
  const [value, setValue] = useState(urlValue)

  // Sync from the URL (e.g. a cleared filter elsewhere) without stomping on
  // active typing; debounce writes back so typing doesn't hammer the router.
  useEffect(() => {
    setValue((current) => (current === urlValue ? current : urlValue))
  }, [urlValue])

  useEffect(() => {
    if (value === urlValue) return
    const t = setTimeout(() => set({ [param]: value || null }), 350)
    return () => clearTimeout(t)
  }, [value, urlValue, param, set])

  return (
    <Input
      type={type}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className={`h-8 ${width} text-xs`}
    />
  )
}

export function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={
            opt.value === value
              ? 'rounded-full bg-primary-600 px-3 py-1 text-xs font-medium text-white'
              : 'rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50'
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export interface PickedMandate {
  gcMandateId: string
  customerLabel: string
  reference: string | null
}

/**
 * Two-step picker: search GoCardless customers, then choose one of their
 * chargeable mandates. Used by the new-plan and collect-payment forms.
 * `initialCustomer` skips straight to the mandate step (e.g. arriving from
 * a customer record with ?customer=CU…).
 */
export function CustomerMandatePicker({
  value,
  onChange,
  initialCustomer = null,
}: {
  value: PickedMandate | null
  onChange: (picked: PickedMandate | null) => void
  initialCustomer?: { gcCustomerId: string; label: string } | null
}) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [customer, setCustomer] = useState<{ gcCustomerId: string; label: string } | null>(
    initialCustomer,
  )

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(t)
  }, [q])

  const customers = trpc.gocardless.customers.list.useQuery(
    { q: debounced, link: 'all', pageSize: 6 },
    { enabled: !customer && debounced.trim().length >= 2 },
  )
  const mandates = trpc.gocardless.mandates.list.useQuery(
    { gcCustomerId: customer?.gcCustomerId ?? '', chargeableOnly: true, pageSize: 10 },
    { enabled: customer !== null },
  )

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
        <span>
          <span className="font-medium text-neutral-900">{value.customerLabel}</span>{' '}
          <code className="font-mono text-xs text-neutral-500">{value.gcMandateId}</code>
        </span>
        <Button type="button" size="xs" variant="ghost" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    )
  }

  if (customer) {
    const items = mandates.data?.items ?? []
    return (
      <div className="rounded-md border border-neutral-200 bg-white p-2">
        <div className="flex items-center justify-between gap-2 px-1 pb-1 text-xs text-neutral-600">
          <span>
            Mandates for <span className="font-medium text-neutral-900">{customer.label}</span>
          </span>
          <Button type="button" size="xs" variant="ghost" onClick={() => setCustomer(null)}>
            Back
          </Button>
        </div>
        {mandates.isLoading ? (
          <p className="px-3 py-2 text-xs text-neutral-500">Loading mandates…</p>
        ) : items.length === 0 ? (
          <p className="px-3 py-2 text-xs text-neutral-500">
            No chargeable mandate — send this customer a setup link first (Customers tab).
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {items.map((m) => (
              <li key={m.gcMandateId}>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      gcMandateId: m.gcMandateId,
                      customerLabel: customer.label,
                      reference: m.reference,
                    })
                  }
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50"
                >
                  <code className="font-mono text-xs">{m.gcMandateId}</code>
                  <span className="flex items-center gap-2">
                    {m.reference ? (
                      <span className="text-xs text-neutral-500">{m.reference}</span>
                    ) : null}
                    <Badge tone={MANDATE_TONE[m.state] ?? 'neutral'}>
                      {statusLabel(m.state)}
                    </Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const items = customers.data?.items ?? []
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-2">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search GoCardless customers by name or email…"
        autoFocus
      />
      {debounced.trim().length >= 2 ? (
        <ul className="mt-2 max-h-48 divide-y divide-neutral-100 overflow-y-auto">
          {customers.isLoading ? (
            <li className="px-3 py-2 text-xs text-neutral-500">Searching…</li>
          ) : items.length === 0 ? (
            <li className="px-3 py-2 text-xs text-neutral-500">No matches.</li>
          ) : (
            items.map((c) => (
              <li key={c.gcCustomerId}>
                <button
                  type="button"
                  onClick={() =>
                    setCustomer({
                      gcCustomerId: c.gcCustomerId,
                      label: c.name ?? c.email ?? c.gcCustomerId,
                    })
                  }
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50"
                >
                  <span className="font-medium text-neutral-900">
                    {c.name ?? c.email ?? c.gcCustomerId}
                  </span>
                  <span className="truncate text-xs text-neutral-500">{c.email ?? ''}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : (
        <p className="mt-2 px-1 text-[11px] text-neutral-500">Type at least 2 characters.</p>
      )}
    </div>
  )
}

/** Inline contact search (mirrors the slack-mentions tray picker). */
export function ContactSearch({
  onPick,
  busy,
  placeholder,
}: {
  onPick: (contactId: string, displayName: string) => void | Promise<void>
  busy?: boolean
  placeholder?: string
}) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(t)
  }, [q])
  const results = trpc.contact.list.useQuery(
    { q: debounced, limit: 6 },
    { enabled: debounced.trim().length >= 2 },
  )
  const items = results.data?.items ?? []
  return (
    <div className="w-full">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder ?? 'Search contacts by name, email, phone…'}
      />
      {debounced.trim().length >= 2 ? (
        <ul className="mt-1 max-h-44 divide-y divide-neutral-100 overflow-y-auto rounded border border-neutral-200 bg-white">
          {results.isLoading ? (
            <li className="px-3 py-2 text-xs text-neutral-500">Searching…</li>
          ) : items.length === 0 ? (
            <li className="px-3 py-2 text-xs text-neutral-500">No matches.</li>
          ) : (
            items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onPick(c.id, c.displayName)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 disabled:opacity-50"
                >
                  <span className="font-medium text-neutral-900">{c.displayName}</span>
                  <span className="truncate text-xs text-neutral-500">
                    {c.email ?? c.phoneE164 ?? ''}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
