// Contacts list page. RSC: reads via the tRPC server-side caller. Pagination,
// sort, page-size and filter state are URL-driven so links are shareable. The
// rich table (selection + bulk actions + sort columns) is the `<ContactsTable>`
// client island below. Offset pagination (page + pageSize) gives the agent a
// total + "showing X–Y of Z"; the multi-select faceted filters let several
// values be chosen per facet at once.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { FacetedFilter } from '@/components/ui/faceted-filter'
import { ClearFiltersButton, FilterBar, ToggleFilter } from '@/components/ui/filter-bar'
import { PageSizeSelect, SortMenu, type SortOption } from '@/components/ui/list-controls'
import { SearchField } from '@/components/ui/search-field'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { ContactsExportButton } from './ContactsExportButton'
import { ContactsTable } from './ContactsTable'
import { QuickAddContactButton } from './QuickAddContactButton'

interface PageSearchParams {
  q?: string
  company?: string
  kind?: string
  bookingStatus?: string
  labels?: string
  hasHours?: string
  sortBy?: string
  sortDir?: string
  page?: string
  pageSize?: string
}

type BookingStatus = 'lead' | 'registered_no_hours' | 'registered_with_hours'
type ContactKind = 'unclassified' | 'parent' | 'student' | 'tutor' | 'other'

const BOOKING_FILTERS: ReadonlyArray<{ value: BookingStatus; label: string }> = [
  { value: 'lead', label: 'Leads' },
  { value: 'registered_no_hours', label: 'Registered' },
  { value: 'registered_with_hours', label: 'Booked hours' },
]

const KIND_VALUES: ReadonlyArray<ContactKind> = [
  'unclassified',
  'parent',
  'student',
  'tutor',
  'other',
]

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 20

const SORT_FIELDS = ['name', 'createdAt', 'hoursBooked', 'hoursDelivered', 'lastLessonAt'] as const
const SORT_OPTIONS: ReadonlyArray<SortOption> = [
  { value: 'createdAt', label: 'Newest added', defaultDir: 'desc' },
  { value: 'name', label: 'Name', defaultDir: 'asc' },
  { value: 'hoursBooked', label: 'Hours booked', defaultDir: 'desc' },
  { value: 'hoursDelivered', label: 'Hours completed', defaultDir: 'desc' },
  { value: 'lastLessonAt', label: 'Last lesson', defaultDir: 'desc' },
]

/** A row from `trpc.company.pickList`. */
interface CompanyOption {
  id: string
  name: string
  slug: string
  color: string | null
}

function splitParam(raw?: string): string[] {
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []
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

  const companies: CompanyOption[] = await caller.company.pickList()
  const bySlug = new Map(companies.map((c) => [c.slug, c]))
  const companyIds = splitParam(sp.company)
    .map((slug) => bySlug.get(slug)?.id)
    .filter((id): id is string => !!id)

  const kinds = splitParam(sp.kind).filter((k): k is ContactKind =>
    (KIND_VALUES as ReadonlyArray<string>).includes(k),
  )
  const bookingStatuses = splitParam(sp.bookingStatus).filter((b): b is BookingStatus =>
    BOOKING_FILTERS.some((f) => f.value === b),
  )

  const labels = await caller.accountLabel.pickList()
  const labelIds = splitParam(sp.labels)
  // "Has hours" quick filter — customers with a meaningful booked balance, the
  // population the risk system cares about.
  const hasHours = sp.hasHours === '1'

  const sortBy = (SORT_FIELDS as ReadonlyArray<string>).includes(sp.sortBy ?? '')
    ? (sp.sortBy as (typeof SORT_FIELDS)[number])
    : 'createdAt'
  const sortDir: 'asc' | 'desc' = sp.sortDir === 'asc' ? 'asc' : 'desc'

  const pageSizeRaw = Number(sp.pageSize)
  const pageSize = (PAGE_SIZE_OPTIONS as ReadonlyArray<number>).includes(pageSizeRaw)
    ? pageSizeRaw
    : DEFAULT_PAGE_SIZE
  const page = Math.max(1, Number(sp.page) || 1)

  const data = await caller.contact.list({
    page,
    limit: pageSize,
    q: sp.q && sp.q.trim() ? sp.q.trim() : undefined,
    ...(companyIds.length > 0 ? { companyIds } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(bookingStatuses.length > 0 ? { bookingStatuses } : {}),
    ...(labelIds.length > 0 ? { labelIds } : {}),
    ...(hasHours ? { minHoursBooked: 1 } : {}),
    sortBy,
    sortDir,
  })

  const total = data.total

  // Carried into the table for the sortable column-header links. Excludes
  // `page` so changing the sort resets to page 1.
  const baseQuery: Record<string, string> = {
    ...(sp.q ? { q: sp.q } : {}),
    ...(sp.company ? { company: sp.company } : {}),
    ...(sp.kind ? { kind: sp.kind } : {}),
    ...(sp.bookingStatus ? { bookingStatus: sp.bookingStatus } : {}),
    ...(sp.labels ? { labels: sp.labels } : {}),
    ...(sp.hasHours ? { hasHours: sp.hasHours } : {}),
    ...(sp.sortBy ? { sortBy: sp.sortBy } : {}),
    ...(sp.sortDir ? { sortDir: sp.sortDir } : {}),
    ...(sp.pageSize ? { pageSize: sp.pageSize } : {}),
  }

  return (
    <>
      <PageHeader
        title="B2C Customers"
        subtitle={`${total} customer${total === 1 ? '' : 's'}${sp.q ? ` matching “${sp.q}”` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <ContactsExportButton
              q={sp.q}
              companyIds={companyIds}
              kinds={kinds}
              bookingStatuses={bookingStatuses}
              labelIds={labelIds}
              hasHours={hasHours}
            />
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
            multiple
            options={companies.map((c) => ({
              value: c.slug,
              label: c.name,
              color: c.color ?? undefined,
            }))}
          />
          <FacetedFilter
            paramKey="kind"
            label="Type"
            multiple
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
            multiple
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
          <div className="ml-auto flex items-center gap-2">
            <SortMenu options={SORT_OPTIONS} defaultValue="createdAt" />
            <PageSizeSelect defaultValue={DEFAULT_PAGE_SIZE} options={PAGE_SIZE_OPTIONS} />
          </div>
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
          baseQuery={baseQuery}
          total={total}
          page={page}
          pageSize={pageSize}
          role={role}
        />
      </PageBody>
    </>
  )
}
