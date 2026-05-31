// Contacts list page. RSC: reads via the tRPC server-side caller. Pagination
// and filter state are URL-driven so links are shareable. The rich table
// (selection + bulk actions + sort columns) is the `<ContactsTable>` client
// island below.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { Button } from '@/components/ui/button'
import { SearchIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { createServerCaller } from '@/lib/trpc/server'
import { getCurrentUser } from '@/lib/auth/server'

import { ContactsExportButton } from './ContactsExportButton'
import { ContactsTable } from './ContactsTable'

interface PageSearchParams {
  q?: string
  cursorId?: string
  cursorAt?: string
  company?: string
  kind?: string
  bookingStatus?: string
  sortBy?: string
  sortDir?: string
}

type BookingStatus = 'lead' | 'registered_no_hours' | 'registered_with_hours'

const BOOKING_FILTERS: ReadonlyArray<{ value: BookingStatus; label: string }> = [
  { value: 'lead', label: 'Leads' },
  { value: 'registered_no_hours', label: 'Registered' },
  { value: 'registered_with_hours', label: 'Booked hours' },
]

/** A row from `trpc.company.pickList`. */
interface CompanyOption {
  id: string
  name: string
  slug: string
  color: string | null
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>
}) {
  const sp = await searchParams
  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  const caller = await createServerCaller()
  const cursor =
    sp.cursorId && sp.cursorAt ? { id: sp.cursorId, createdAt: new Date(sp.cursorAt) } : undefined
  const companies: CompanyOption[] = await caller.company.pickList()
  const bySlug = new Map(companies.map((c) => [c.slug, c]))
  const activeCompany =
    sp.company && bySlug.has(sp.company) ? (bySlug.get(sp.company) as CompanyOption) : undefined
  const kind =
    sp.kind === 'parent' || sp.kind === 'student' || sp.kind === 'tutor' || sp.kind === 'other'
      ? sp.kind
      : undefined
  const bookingStatus: BookingStatus | undefined =
    sp.bookingStatus === 'lead' ||
    sp.bookingStatus === 'registered_no_hours' ||
    sp.bookingStatus === 'registered_with_hours'
      ? sp.bookingStatus
      : undefined
  const sortBy: 'name' | 'createdAt' = sp.sortBy === 'name' ? 'name' : 'createdAt'
  const sortDir: 'asc' | 'desc' = sp.sortDir === 'asc' ? 'asc' : 'desc'
  const data = await caller.contact.list({
    cursor,
    limit: 25,
    q: sp.q && sp.q.trim() ? sp.q.trim() : undefined,
    companyId: activeCompany?.id,
    kind,
    bookingStatus,
    sortBy,
    sortDir,
  })

  function chipHref(next: CompanyOption | undefined): {
    pathname: string
    query: Record<string, string>
  } {
    const q: Record<string, string> = {}
    if (sp.q) q.q = sp.q
    if (next) q.company = next.slug
    return { pathname: '/contacts', query: q }
  }

  return (
    <>
      <PageHeader
        title="B2C Customers"
        subtitle={`${data.items.length} on this page${sp.q ? ` matching “${sp.q}”` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <ContactsExportButton q={sp.q} companyId={activeCompany?.id} />
            <Link href="/contacts/new">
              <Button>New contact</Button>
            </Link>
          </div>
        }
      />
      <PageBody>
        <form className="flex gap-2" method="GET">
          <div className="relative max-w-sm flex-1">
            <SearchIcon
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
            />
            <Input
              type="search"
              name="q"
              defaultValue={sp.q ?? ''}
              placeholder="Search by name, email, or phone"
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        {/* Company filter chips */}
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <Link
            href={chipHref(undefined)}
            className={
              !activeCompany
                ? 'inline-flex items-center rounded-full bg-neutral-900 px-3 py-1 text-xs font-medium text-white'
                : 'inline-flex items-center rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900'
            }
          >
            All companies
          </Link>
          {companies.map((c) => {
            const active = activeCompany?.id === c.id
            return (
              <Link
                key={c.id}
                href={chipHref(c)}
                className={
                  active
                    ? 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-white'
                    : 'inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50'
                }
                style={active ? { backgroundColor: c.color ?? '#475569' } : undefined}
              >
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: c.color ?? '#94a3b8' }}
                />
                {c.name}
              </Link>
            )
          })}
        </div>

        {/* Kind filter — contacts are students or parents/guardians (no
            Family grouping in this surface). */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {(['parent', 'student', 'tutor', 'other'] as const).map((k) => {
            const active = kind === k
            const params = new URLSearchParams()
            if (sp.q) params.set('q', sp.q)
            if (activeCompany) params.set('company', activeCompany.slug)
            if (sp.bookingStatus) params.set('bookingStatus', sp.bookingStatus)
            if (sp.sortBy) params.set('sortBy', sp.sortBy)
            if (sp.sortDir) params.set('sortDir', sp.sortDir)
            if (!active) params.set('kind', k)
            return (
              <Link
                key={k}
                href={`/contacts?${params.toString()}`}
                className={
                  active
                    ? 'inline-flex items-center rounded-full bg-neutral-900 px-3 py-1 text-xs font-medium text-white'
                    : 'inline-flex items-center rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900'
                }
              >
                {k}
              </Link>
            )
          })}
        </div>

        {/* Booking status filter (CLAUDE.md §15) — the primary lens for the
            sales team: fresh leads vs registered vs booked-hours. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            Status
          </span>
          {BOOKING_FILTERS.map((f) => {
            const active = bookingStatus === f.value
            const params = new URLSearchParams()
            if (sp.q) params.set('q', sp.q)
            if (activeCompany) params.set('company', activeCompany.slug)
            if (sp.kind) params.set('kind', sp.kind)
            if (sp.sortBy) params.set('sortBy', sp.sortBy)
            if (sp.sortDir) params.set('sortDir', sp.sortDir)
            if (!active) params.set('bookingStatus', f.value)
            return (
              <Link
                key={f.value}
                href={`/contacts?${params.toString()}`}
                className={
                  active
                    ? 'inline-flex items-center rounded-full bg-primary-600 px-3 py-1 text-xs font-medium text-white'
                    : 'inline-flex items-center rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900'
                }
              >
                {f.label}
              </Link>
            )
          })}
        </div>

        <ContactsTable
          rows={data.items.map((c) => ({
            id: c.id,
            displayName: c.displayName,
            email: c.email,
            phoneE164: c.phoneE164,
            kind: c.kind,
            companies: c.companies,
            bookingStatus: c.bookingStatus,
            hoursBooked: c.hoursBooked,
            lastLessonAt: c.lastLessonAt,
            amountSpentMinor: c.amountSpentMinor,
            callCount: c.callCount,
            emailCount: c.emailCount,
            textCount: c.textCount,
            lastInteractionAt: c.lastInteractionAt,
            createdAt: c.createdAt,
          }))}
          nextCursor={
            data.nextCursor
              ? {
                  id: data.nextCursor.id,
                  createdAt: data.nextCursor.createdAt.toISOString(),
                }
              : null
          }
          baseQuery={{
            ...(sp.q ? { q: sp.q } : {}),
            ...(activeCompany ? { company: activeCompany.slug } : {}),
            ...(sp.kind ? { kind: sp.kind } : {}),
            ...(sp.bookingStatus ? { bookingStatus: sp.bookingStatus } : {}),
            ...(sp.sortBy ? { sortBy: sp.sortBy } : {}),
            ...(sp.sortDir ? { sortDir: sp.sortDir } : {}),
          }}
          role={role}
        />
      </PageBody>
    </>
  )
}
