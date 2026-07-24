// CSV export for the B2C customers list. A dropdown with two scopes:
//   • "Export current view" — honours every active filter (search + facets +
//     ranges), so the CSV matches exactly what's on screen.
//   • "Export all customers" — the whole customer base, filters ignored.
// Both stream the comprehensive `contact.exportRows` procedure page by page
// (keyset cursor) so the file is a COMPLETE record of each customer — full
// profile, address, booking + engagement figures, comms counts, tags, family,
// and the extra points of contact — not the compact set the table shows.
// Each run records `contact.exported` in the audit log (CLAUDE.md §20/§21).

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Popover } from '@/components/ui/popover'
import { downloadCsv, type CsvColumn } from '@/lib/csv'
import { trpc } from '@/lib/trpc/client'
import type { ContactExportRow } from '@/lib/view-models/contact'

const KIND_LABEL: Record<string, string> = {
  unclassified: 'Unclassified',
  parent: 'Parent',
  student: 'Student',
  tutor: 'Tutor',
  la_caseworker: 'LA caseworker',
  other: 'Other',
}

const STATUS_LABEL: Record<string, string> = {
  lead: 'Lead',
  registered_no_hours: 'Registered (no hours)',
  registered_with_hours: 'Registered (booked hours)',
}

const SEND_STATUS_LABEL: Record<string, string> = {
  none: 'None',
  send_support: 'SEND support',
  ehcp_in_place: 'EHCP in place',
  ehcp_in_progress: 'EHCP in progress',
  other: 'Other',
}

// Comprehensive column set — every useful field on the contact, ordered
// identity → contact channels → personal → address → education → preferences
// → tags → booking/engagement → activity → record meta.
const COLUMNS: CsvColumn<ContactExportRow>[] = [
  { header: 'Contact ID', value: (r) => r.id },
  { header: 'Display name', value: (r) => r.displayName },
  { header: 'First name', value: (r) => r.firstName ?? '' },
  { header: 'Last name', value: (r) => r.lastName ?? '' },
  { header: 'Type', value: (r) => KIND_LABEL[r.kind] ?? r.kind },
  { header: 'Email', value: (r) => r.email ?? '' },
  { header: 'Phone (E.164)', value: (r) => r.phoneE164 ?? '' },
  { header: 'Additional emails', value: (r) => r.additionalEmails },
  { header: 'Additional phones', value: (r) => r.additionalPhones },
  { header: 'Other contact points', value: (r) => r.otherChannels },
  { header: 'Mailchimp email', value: (r) => r.mailchimpEmail ?? '' },
  { header: 'Preferred contact method', value: (r) => r.preferredContactMethod ?? '' },
  { header: 'Date of birth', value: (r) => (r.dateOfBirth ? new Date(r.dateOfBirth) : '') },
  { header: 'Is minor', value: (r) => r.isMinor },
  { header: 'Pronouns', value: (r) => r.pronouns ?? '' },
  { header: 'Job title', value: (r) => r.jobTitle ?? '' },
  { header: 'Address line 1', value: (r) => r.addressLine1 ?? '' },
  { header: 'Address line 2', value: (r) => r.addressLine2 ?? '' },
  { header: 'City', value: (r) => r.city ?? '' },
  { header: 'Postcode', value: (r) => r.postcode ?? '' },
  { header: 'Country', value: (r) => r.country ?? '' },
  { header: 'Timezone', value: (r) => r.timezone ?? '' },
  { header: 'School', value: (r) => r.schoolName ?? '' },
  { header: 'Year group', value: (r) => r.yearGroup ?? '' },
  {
    header: 'SEND status',
    value: (r) => (r.sendStatus ? (SEND_STATUS_LABEL[r.sendStatus] ?? r.sendStatus) : ''),
  },
  { header: 'Exam target', value: (r) => r.examTarget ?? '' },
  { header: 'Companies', value: (r) => r.companies },
  { header: 'Labels', value: (r) => r.labels },
  { header: 'Subjects', value: (r) => r.subjects },
  { header: 'Enquiry types', value: (r) => r.enquiryTypes },
  { header: 'Referral source', value: (r) => r.referralSource ?? '' },
  { header: 'Family', value: (r) => r.familyName ?? '' },
  { header: 'Booking status', value: (r) => STATUS_LABEL[r.bookingStatus] ?? r.bookingStatus },
  { header: 'Booking site ID', value: (r) => r.bookingContactId ?? '' },
  { header: 'Hours booked', value: (r) => r.hoursBooked ?? '' },
  { header: 'Hours delivered', value: (r) => r.hoursDelivered ?? '' },
  { header: 'Hours remaining', value: (r) => r.hoursRemaining ?? '' },
  {
    header: 'Amount spent (GBP)',
    value: (r) => (r.amountSpentMinor != null ? (r.amountSpentMinor / 100).toFixed(2) : ''),
  },
  { header: 'Last lesson', value: (r) => (r.lastLessonAt ? new Date(r.lastLessonAt) : '') },
  { header: 'Calls', value: (r) => r.callCount },
  { header: 'Texts', value: (r) => r.textCount },
  { header: 'Emails', value: (r) => r.emailCount },
  { header: 'Active complaints', value: (r) => r.complaintCount },
  { header: 'Hours-risk level', value: (r) => r.riskLevel },
  { header: 'Hours-risk score', value: (r) => r.riskScore },
  {
    header: 'Last contacted',
    value: (r) => (r.lastInteractionAt ? new Date(r.lastInteractionAt) : ''),
  },
  { header: 'Notes', value: (r) => r.notes ?? '' },
  { header: 'Added', value: (r) => new Date(r.createdAt) },
  { header: 'Updated', value: (r) => new Date(r.updatedAt) },
]

type Kind = 'unclassified' | 'parent' | 'student' | 'tutor' | 'other'
type BookingStatus = 'lead' | 'registered_no_hours' | 'registered_with_hours'

interface Props {
  q?: string
  companyIds?: string[]
  kinds?: Kind[]
  bookingStatuses?: BookingStatus[]
  labelIds?: string[]
  subjectIds?: string[]
  countries?: string[]
  enquiryCategories?: string[]
  hasHours?: boolean
  /** Filtered total (from the page) — shown on the "current view" option. */
  total?: number
}

// Streaming safety cap. Each page is a fixed handful of queries, so a large
// export is cheap; the cap just bounds the file / browser memory.
const PAGE_SIZE = 200
const MAX_ROWS = 50_000
const MAX_PAGES = Math.ceil(MAX_ROWS / PAGE_SIZE) + 1

export function ContactsExportMenu({
  q,
  companyIds,
  kinds,
  bookingStatuses,
  labelIds,
  subjectIds,
  countries,
  enquiryCategories,
  hasHours,
  total,
}: Props) {
  const utils = trpc.useUtils()
  const recordExport = trpc.audit.recordExport.useMutation()
  const [busy, setBusy] = useState<null | 'filtered' | 'all'>(null)

  // Normalise the search term exactly as the table's list read does
  // (`sp.q.trim() || undefined`). A whitespace-only query is treated as no
  // filter — otherwise the server's `.trim().min(1)` zod rejects "  " as a
  // BAD_REQUEST and the export fails while the table stays unfiltered.
  const searchQ = q?.trim() ? q.trim() : undefined

  const hasActiveFilters =
    !!searchQ ||
    !!companyIds?.length ||
    !!kinds?.length ||
    !!bookingStatuses?.length ||
    !!labelIds?.length ||
    !!subjectIds?.length ||
    !!countries?.length ||
    !!enquiryCategories?.length ||
    !!hasHours

  // The active filter inputs, in the exact shape `contact.exportRows` accepts.
  function activeFilters() {
    return {
      ...(searchQ ? { q: searchQ } : {}),
      ...(companyIds && companyIds.length > 0 ? { companyIds } : {}),
      ...(kinds && kinds.length > 0 ? { kinds } : {}),
      ...(bookingStatuses && bookingStatuses.length > 0 ? { bookingStatuses } : {}),
      ...(labelIds && labelIds.length > 0 ? { labelIds } : {}),
      ...(subjectIds && subjectIds.length > 0 ? { subjectIds } : {}),
      ...(countries && countries.length > 0 ? { countries } : {}),
      ...(enquiryCategories && enquiryCategories.length > 0 ? { enquiryCategories } : {}),
      ...(hasHours ? { minHoursBooked: 1 } : {}),
    }
  }

  // Short human summary for the audit trail. Multi-value facets are summarised
  // by COUNT (not their raw values) and the whole string is capped, so it can
  // never exceed the audit endpoint's 1000-char limit and silently skip the
  // `contact.exported` write (§20/§21).
  function filterSummary(scope: 'filtered' | 'all', truncated: boolean): string {
    if (scope === 'all') {
      return truncated ? 'all customers (capped at 50,000)' : 'all customers (no filter)'
    }
    const parts: string[] = []
    if (searchQ) parts.push(`search "${searchQ}"`)
    if (companyIds?.length) parts.push(`${companyIds.length} companies`)
    if (kinds?.length) parts.push(`kinds ${kinds.join(',')}`)
    if (bookingStatuses?.length) parts.push(`status ${bookingStatuses.join(',')}`)
    if (labelIds?.length) parts.push(`${labelIds.length} labels`)
    if (subjectIds?.length) parts.push(`${subjectIds.length} subjects`)
    if (countries?.length) parts.push(`${countries.length} countries`)
    if (enquiryCategories?.length) parts.push(`${enquiryCategories.length} enquiry types`)
    if (hasHours) parts.push('has hours')
    if (truncated) parts.push('capped at 50,000')
    const s = `current view — ${parts.length ? parts.join('; ') : 'no filter'}`
    return s.length > 1000 ? `${s.slice(0, 999)}…` : s
  }

  async function runExport(scope: 'filtered' | 'all') {
    setBusy(scope)
    try {
      const filters = scope === 'filtered' ? activeFilters() : {}
      const all: ContactExportRow[] = []
      let cursor: { id: string; createdAt: Date } | undefined
      // Truncated = we stopped at the row cap while the server still had more.
      let truncated = false
      for (let i = 0; i < MAX_PAGES; i += 1) {
        const page = await utils.contact.exportRows.fetch({
          ...filters,
          cursor,
          limit: PAGE_SIZE,
        })
        all.push(...page.items)
        if (!page.nextCursor) break
        if (all.length >= MAX_ROWS) {
          truncated = true
          break
        }
        cursor = {
          id: page.nextCursor.id,
          createdAt: new Date(page.nextCursor.createdAt),
        }
      }
      const rows = all.length > MAX_ROWS ? all.slice(0, MAX_ROWS) : all
      downloadCsv(scope === 'all' ? 'customers_all' : 'customers_filtered', rows, COLUMNS)
      recordExport.mutate({
        kind: 'contact',
        rowCount: rows.length,
        filterSummary: filterSummary(scope, truncated),
      })
      if (truncated) {
        toast.warning(
          `Exported the first ${MAX_ROWS.toLocaleString()} customers — the set is larger, so the file is capped. Narrow the filters to export the rest.`,
        )
      }
    } catch (err) {
      // A failed export must not be a silent no-op (§26 — toast.error on
      // user-facing actions).
      toast.error(err instanceof Error ? err.message : 'Could not export customers')
    } finally {
      setBusy(null)
      // Drop the per-page query data we accumulated so a big export doesn't
      // sit in the react-query cache after the file is saved.
      void utils.contact.exportRows.reset()
    }
  }

  const filteredLabel =
    total != null && hasActiveFilters ? `Export current view (${total})` : 'Export current view'

  return (
    <Popover
      align="end"
      triggerClassName="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-800 shadow-card transition-colors hover:border-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
      trigger={
        <>
          <DownloadGlyph />
          {busy ? 'Exporting…' : 'Export CSV'}
          <ChevronGlyph />
        </>
      }
    >
      {(close) => (
        <div className="min-w-[15rem] p-1">
          <button
            type="button"
            disabled={busy != null}
            onClick={() => {
              close()
              void runExport('filtered')
            }}
            className="flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="text-sm font-medium text-neutral-900">{filteredLabel}</span>
            <span className="text-[11px] text-neutral-500">
              {hasActiveFilters
                ? 'Only the customers matching the current filters'
                : 'No filters active — same as all customers'}
            </span>
          </button>
          <button
            type="button"
            disabled={busy != null}
            onClick={() => {
              close()
              void runExport('all')
            }}
            className="mt-0.5 flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="text-sm font-medium text-neutral-900">Export all customers</span>
            <span className="text-[11px] text-neutral-500">
              Every customer, ignoring the filters above
            </span>
          </button>
          <p className="px-3 pb-1 pt-2 text-[11px] text-neutral-400">
            Comprehensive — full profile, contact points, booking &amp; activity.
          </p>
        </div>
      )}
    </Popover>
  )
}

function DownloadGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function ChevronGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-neutral-400"
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
