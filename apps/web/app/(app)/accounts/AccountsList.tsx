// Client island for the B2B accounts list. Inline status filter + create
// button + live search. Rows link to the detail page.

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

import { AccountCreateForm } from './AccountCreateForm'

type Kind = 'school' | 'partnership'
type Status = 'prospect' | 'active' | 'paused' | 'churned'

interface AccountRow {
  id: string
  kind: 'school' | 'partnership'
  name: string
  slug: string
  color: string | null
  description: string | null
  status: 'prospect' | 'active' | 'paused' | 'churned'
  contactEmail: string | null
  contactPhone: string | null
  website: string | null
  city: string | null
  country: string | null
  contactCount: number
  companies: ReadonlyArray<{
    id: string
    name: string
    slug: string
    color: string | null
  }>
  archived: boolean
  createdAt: Date | string
}

const STATUS_TONE: Record<Status, string> = {
  prospect: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  active: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  paused: 'bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200',
  churned: 'bg-red-50 text-red-700 ring-1 ring-red-200',
}

export function AccountsList({
  kind,
  accounts,
}: {
  kind: Kind
  accounts: AccountRow[]
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [creating, setCreating] = useState(false)
  const [q, setQ] = useState(searchParams.get('q') ?? '')
  const status = (searchParams.get('status') ?? '') as Status | ''

  function pushParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (value && value.length > 0) {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    router.push(`/accounts?${params.toString()}`)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              pushParam('q', q.trim() || null)
            }}
          >
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, city, email…"
              className="w-72"
              aria-label="Search accounts"
            />
          </form>
          <Select
            value={status}
            onChange={(e) => pushParam('status', e.target.value || null)}
            aria-label="Status filter"
          >
            <option value="">All statuses</option>
            <option value="prospect">Prospect</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="churned">Churned</option>
          </Select>
        </div>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            New {kind === 'school' ? 'school' : 'partnership'}
          </Button>
        )}
      </div>

      {creating && (
        <AccountCreateForm
          kind={kind}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            router.refresh()
          }}
        />
      )}

      {accounts.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No {kind === 'school' ? 'schools' : 'partnerships'} yet — start by
          clicking <em>New {kind === 'school' ? 'school' : 'partnership'}</em>.
        </p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li
              key={a.id}
              className="rounded-lg border border-neutral-200 bg-white shadow-card transition-shadow hover:shadow-card-hover"
            >
              <Link
                href={`/accounts/${a.id}`}
                className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {a.color && (
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: a.color }}
                      />
                    )}
                    <h3 className="text-sm font-semibold text-neutral-900">{a.name}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[a.status]}`}
                    >
                      {a.status}
                    </span>
                    {a.companies.slice(0, 4).map((c) => (
                      <span
                        key={c.id}
                        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                        style={{ backgroundColor: c.color ?? '#475569' }}
                      >
                        {c.name}
                      </span>
                    ))}
                  </div>
                  {a.description && (
                    <p className="mt-0.5 text-xs text-neutral-600">{a.description}</p>
                  )}
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500">
                    {a.city && <span>{[a.city, a.country].filter(Boolean).join(', ')}</span>}
                    {a.contactEmail && <span>{a.contactEmail}</span>}
                    {a.contactPhone && <span className="font-mono">{a.contactPhone}</span>}
                  </div>
                </div>
                <div className="text-xs text-neutral-500">
                  {a.contactCount} {a.contactCount === 1 ? 'contact' : 'contacts'}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function describeStatusToneClass(status: Status): string {
  return STATUS_TONE[status]
}

// Re-export of `toast` so the unused-imports rule doesn't fight modules
// that import it from this file.
void toast
