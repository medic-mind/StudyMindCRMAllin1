// Contacts list page. RSC: reads via the tRPC server-side caller. Pagination
// and filter state are URL-driven so links are shareable. The rich table
// (selection + bulk actions + sort columns) is the `<ContactsTable>` client
// island below.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { FacetedFilter } from '@/components/ui/faceted-filter'
import { ClearFiltersButton, FilterBar, ToggleFilter } from '@/components/ui/filter-bar'
import { SearchField } from '@/components/ui/search-field'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { ContactsExportButton } from './ContactsExportButton'
import { ContactsTable } from './ContactsTable'
import { QuickAddContactButton } from './QuickAddContactButton'

interface PageSearchParams {
  q?: string
  cursorId?: string
  cursorAt?: string
  company?: string
  kind?: string
  bookingStatus?: string
  labels?: string
  hasHours?: string
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
  const SORT_FIELDS = ['name', 'createdAt', 'hoursBooked', 'hoursDelivered', 'lastLessonAt'] as const
  const sortBy = (SORT_FIELDS as ReadonlyArray<string>).includes(sp.sortBy ?? '')
    ? (sp.sortBy as (typeof SORT_FIELDS)[number])
    : 'createdAt'
  const sortDir: 'asc' | 'desc' = sp.sortDir === 'asc' ? 'asc' : 'desc'
  const labels = await caller.accountLabel.pickList()
  const labelIds = sp.labels
    ? sp.labels.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined
  // "Has hours" quick filter — customers with a meaningful booked balance, the
  // population the risk system cares about.
  const hasHours = sp.hasHours === '1'
  const data = await caller.contact.list({
    cursor,
    limit: 25,
    q: sp.q && sp.q.trim() ? sp.q.trim() : undefined,
    companyId: activeCompany?.id,
    kind,
    bookingStatus,
    ...(labelIds && labelIds.length > 0 ? { labelIds } : {}),
    ...(hasHours ? { minHoursBooked: 1 } : {}),
    sortBy,
    sortDir,
  })

  return (
    <>
      <PageHeader
        title="B2C Customers"
        subtitle={`${data.items.length} on this page${sp.q ? ` matching “${sp.q}”` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <ContactsExportButton q={sp.q} companyId={activeCompany?.id} />
            <QuickAddContactButton />
          </div>
        }
      />
      <PageBody>
        <FilterBar>
          <SearchField placeholder="Search by name, email, or phone" />
          <FacetedFilter
            paramKey="company"
            label="Company"
            options={companies.map((c) => ({
              value: c.slug,
              label: c.name,
              color: c.color ?? undefined,
            }))}
          />
          <FacetedFilter
            paramKey="kind"
            label="Type"
            options={[
              { value: 'unclassified', label: 'Unclassified' },
              { value: 'parent', label: 'Parent' },
              { value: 'student', label: 'Student' },
              { value: 'tutor', label: 'Tutor' },
              { value: 'other', label: 'Other' },
            ]}
          />
          <FacetedFilter
            paramKey="bookingStatus"
            label="Status"
            options={BOOKING_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
          />
          {labels.length > 0 && (
            <FacetedFilter
              paramKey="labels"
              label="Label"
              multiple
              options={labels.map((l) => ({
                value: l.id,
                label: l.name,
                color: l.color ?? undefined,
              }))}
            />
          )}
          <ToggleFilter paramKey="hasHours" label="Has hours" />
          <Link
            href="/contacts/at-risk"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-100"
          >
            At-risk customers
          </Link>
          <ClearFiltersButton
            paramKeys={['q', 'company', 'kind', 'bookingStatus', 'labels', 'hasHours']}
          />
        </FilterBar>

        <ContactsTable
          rows={data.items.map((c) => ({
            id: c.id,
            displayName: c.displayName,
            email: c.email,
            phoneE164: c.phoneE164,
            kind: c.kind,
            companies: c.companies,
            labels: c.labels,
            bookingStatus: c.bookingStatus,
            hoursBooked: c.hoursBooked,
            hoursDelivered: c.hoursDelivered,
            hoursRemaining: c.hoursRemaining,
            riskLevel: c.riskLevel,
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
            ...(sp.labels ? { labels: sp.labels } : {}),
            ...(sp.hasHours ? { hasHours: sp.hasHours } : {}),
            ...(sp.sortBy ? { sortBy: sp.sortBy } : {}),
            ...(sp.sortDir ? { sortDir: sp.sortDir } : {}),
          }}
          role={role}
        />
      </PageBody>
    </>
  )
}
