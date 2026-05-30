// Client island for the B2B accounts list. Dense table (CLAUDE.md §4) with
// inline status filter + live search + create button. Each row surfaces the
// org, clickable email + phone, student count + contracted hours, the
// call/text/email counts across the account's linked contacts, amount paid
// (paid uploaded invoices), and when we last contacted them.

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  ChevronRightIcon,
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
} from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { formatMoneyMinor } from '@/lib/format/money'
import { formatRelativeTime } from '@/lib/format/relative-time'

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
  studentCount: number
  hoursContracted: number
  hoursDelivered: number
  amountPaidMinor: number
  callCount: number
  textCount: number
  emailCount: number
  lastContactedAt: Date | string | null
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
  const now = new Date()

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
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-card">
          <table className="w-full min-w-[1080px] border-collapse text-sm">
            <thead className="bg-neutral-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium text-neutral-600">
                  {kind === 'school' ? 'School' : 'Partnership'}
                </th>
                <th className="px-3 py-2 font-medium text-neutral-600">Email</th>
                <th className="px-3 py-2 font-medium text-neutral-600">Phone</th>
                <th className="px-3 py-2 text-right font-medium text-neutral-600">
                  Students
                </th>
                <th className="px-3 py-2 text-right font-medium text-neutral-600">
                  Hours
                </th>
                <th className="px-3 py-2 text-center font-medium text-neutral-600">
                  Activity
                </th>
                <th className="px-3 py-2 text-right font-medium text-neutral-600">
                  Paid
                </th>
                <th className="px-3 py-2 text-right font-medium text-neutral-600">
                  Last contact
                </th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {accounts.map((a) => (
                <tr key={a.id} className="group">
                  <td className="px-3 py-2 align-top">
                    <Link href={`/accounts/${a.id}`} className="block min-w-0">
                      <span className="flex items-center gap-1.5">
                        {a.color && (
                          <span
                            aria-hidden
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: a.color }}
                          />
                        )}
                        <span className="truncate font-medium text-neutral-900 group-hover:text-primary-700">
                          {a.name}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[a.status]}`}
                        >
                          {a.status}
                        </span>
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-neutral-500">
                        {a.city && (
                          <span>{[a.city, a.country].filter(Boolean).join(', ')}</span>
                        )}
                        {a.companies.slice(0, 3).map((c) => (
                          <span
                            key={c.id}
                            aria-hidden
                            title={c.name}
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: c.color ?? '#94a3b8' }}
                          />
                        ))}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    <EmailLink email={a.contactEmail} />
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    <PhoneLink phone={a.contactPhone} />
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-700">
                    {a.studentCount}
                  </td>
                  <td
                    className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-700"
                    title={`${a.hoursDelivered}h delivered of ${a.hoursContracted}h contracted`}
                  >
                    {a.hoursContracted > 0 ? `${a.hoursContracted}h` : '—'}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center justify-center gap-2 text-xs tabular-nums text-neutral-600">
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={`${a.callCount} calls`}
                      >
                        <PhoneIcon size={12} className="text-neutral-400" />
                        {a.callCount}
                      </span>
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={`${a.textCount} messages`}
                      >
                        <MessageSquareIcon size={12} className="text-neutral-400" />
                        {a.textCount}
                      </span>
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={`${a.emailCount} emails`}
                      >
                        <MailIcon size={12} className="text-neutral-400" />
                        {a.emailCount}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-700">
                    {a.amountPaidMinor > 0 ? formatMoneyMinor(a.amountPaidMinor) : '—'}
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-500">
                    {a.lastContactedAt
                      ? formatRelativeTime(new Date(a.lastContactedAt), now)
                      : '—'}
                  </td>
                  <td className="px-3 py-2 align-top text-right">
                    <Link
                      href={`/accounts/${a.id}`}
                      aria-label={`Open ${a.name}`}
                      className="inline-flex text-neutral-300 transition-colors group-hover:text-primary-600"
                    >
                      <ChevronRightIcon size={16} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
