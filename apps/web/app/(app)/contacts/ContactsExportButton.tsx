// Export the contacts list to CSV. Re-fetches in 100-row pages from
// `contact.list` until the cursor runs out, then hands the rows to the
// shared `<CsvExportButton>`. Honours the current filters (search + company)
// so the CSV matches what's on screen, not the unfiltered universe.

'use client'

import { useState } from 'react'

import { CsvExportButton } from '@/components/ui/csv-export-button'
import { trpc } from '@/lib/trpc/client'
import type { CsvColumn } from '@/lib/csv'

const STATUS_LABEL: Record<string, string> = {
  lead: 'Lead',
  registered_no_hours: 'Registered (no hours)',
  registered_with_hours: 'Registered (booked hours)',
}

interface Row {
  id: string
  displayName: string
  email: string | null
  phoneE164: string | null
  kind: string
  bookingStatus: string
  companyNames: string
  subjectNames: string
  enquiryTypeNames: string
  callCount: number
  textCount: number
  emailCount: number
  hoursBooked: number | null
  lastLessonAt: Date | string | null
  amountSpentMinor: number | null
  lastInteractionAt: Date | string | null
}

const COLUMNS: CsvColumn<Row>[] = [
  { header: 'Display name', value: (r) => r.displayName },
  { header: 'Email', value: (r) => r.email ?? '' },
  { header: 'Phone (E.164)', value: (r) => r.phoneE164 ?? '' },
  { header: 'Type', value: (r) => r.kind },
  { header: 'Status', value: (r) => STATUS_LABEL[r.bookingStatus] ?? r.bookingStatus },
  { header: 'Companies', value: (r) => r.companyNames },
  { header: 'Subjects', value: (r) => r.subjectNames },
  { header: 'Enquiry types', value: (r) => r.enquiryTypeNames },
  { header: 'Calls', value: (r) => r.callCount },
  { header: 'Texts', value: (r) => r.textCount },
  { header: 'Emails', value: (r) => r.emailCount },
  { header: 'Hours booked', value: (r) => r.hoursBooked ?? '' },
  {
    header: 'Last lesson',
    value: (r) => (r.lastLessonAt ? new Date(r.lastLessonAt) : ''),
  },
  {
    header: 'Amount spent (GBP)',
    // Minor units → pounds with 2dp; blank until the booking sync writes it.
    value: (r) => (r.amountSpentMinor != null ? (r.amountSpentMinor / 100).toFixed(2) : ''),
  },
  {
    header: 'Last contacted',
    value: (r) => (r.lastInteractionAt ? new Date(r.lastInteractionAt) : ''),
  },
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
}

const MAX_ROWS = 5000

export function ContactsExportButton({
  q,
  companyIds,
  kinds,
  bookingStatuses,
  labelIds,
  subjectIds,
  countries,
  enquiryCategories,
  hasHours,
}: Props) {
  const utils = trpc.useUtils()
  const recordExport = trpc.audit.recordExport.useMutation()
  const [pulling, setPulling] = useState(false)

  // A short, human-readable description of the active filters for the audit
  // trail, so "who exported what" is answerable, not just "someone exported".
  function filterSummary(): string {
    const parts: string[] = []
    if (q) parts.push(`search "${q}"`)
    if (companyIds?.length) parts.push(`${companyIds.length} companies`)
    if (kinds?.length) parts.push(`kinds ${kinds.join(',')}`)
    if (bookingStatuses?.length) parts.push(`status ${bookingStatuses.join(',')}`)
    if (labelIds?.length) parts.push(`${labelIds.length} labels`)
    if (subjectIds?.length) parts.push(`${subjectIds.length} subjects`)
    if (countries?.length) parts.push(`countries ${countries.join(',')}`)
    if (enquiryCategories?.length) parts.push(`enquiry ${enquiryCategories.join(',')}`)
    if (hasHours) parts.push('has hours')
    return parts.length ? parts.join('; ') : 'no filter (whole list)'
  }

  async function getRows(): Promise<Row[]> {
    setPulling(true)
    try {
      const all: Row[] = []
      let cursor: { id: string; createdAt: Date } | undefined
      // Loop until the cursor is exhausted or we hit the safety cap. The
      // filters mirror the on-screen list so the CSV matches what's shown.
      for (let i = 0; i < MAX_ROWS / 100 + 1; i += 1) {
        const page = await utils.contact.list.fetch({
          q,
          ...(companyIds && companyIds.length > 0 ? { companyIds } : {}),
          ...(kinds && kinds.length > 0 ? { kinds } : {}),
          ...(bookingStatuses && bookingStatuses.length > 0 ? { bookingStatuses } : {}),
          ...(labelIds && labelIds.length > 0 ? { labelIds } : {}),
          ...(subjectIds && subjectIds.length > 0 ? { subjectIds } : {}),
          ...(countries && countries.length > 0 ? { countries } : {}),
          ...(enquiryCategories && enquiryCategories.length > 0 ? { enquiryCategories } : {}),
          ...(hasHours ? { minHoursBooked: 1 } : {}),
          cursor,
          limit: 100,
        })
        for (const c of page.items) {
          all.push({
            id: c.id,
            displayName: c.displayName,
            email: c.email,
            phoneE164: c.phoneE164,
            kind: c.kind,
            bookingStatus: c.bookingStatus,
            companyNames: c.companies.map((cc) => cc.name).join(' · '),
            subjectNames: c.subjects.map((sub) => sub.name).join(' · '),
            enquiryTypeNames: c.enquiryTypes.join(' · '),
            callCount: c.callCount,
            textCount: c.textCount,
            emailCount: c.emailCount,
            hoursBooked: c.hoursBooked,
            lastLessonAt: c.lastLessonAt,
            amountSpentMinor: c.amountSpentMinor,
            lastInteractionAt: c.lastInteractionAt,
          })
          if (all.length >= MAX_ROWS) break
        }
        if (!page.nextCursor || all.length >= MAX_ROWS) break
        cursor = {
          id: page.nextCursor.id,
          createdAt: new Date(page.nextCursor.createdAt),
        }
      }
      return all
    } finally {
      setPulling(false)
    }
  }

  return (
    <CsvExportButton
      getRows={getRows}
      columns={COLUMNS}
      fileNameBase="contacts"
      label={pulling ? 'Pulling…' : 'Export CSV'}
      onExported={(rowCount) =>
        recordExport.mutate({ kind: 'contact', rowCount, filterSummary: filterSummary() })
      }
    />
  )
}
