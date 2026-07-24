// CSV export for the accounts list. Reads the same `businessAccount.list`
// procedure the page is showing, so the export matches the current filter
// state.

'use client'

import { CsvExportButton } from '@/components/ui/csv-export-button'
import { trpc } from '@/lib/trpc/client'
import type { CsvColumn } from '@/lib/csv'

interface RowCompany {
  id: string
  name: string
  slug: string
  color: string | null
}

interface Row {
  id: string
  kind: 'school' | 'partnership'
  name: string
  slug: string
  status: string
  description: string | null
  contactEmail: string | null
  contactPhone: string | null
  website: string | null
  city: string | null
  country: string | null
  contactCount: number
  studentCount: number
  hoursContracted: number
  hoursDelivered: number
  amountPaidMinor: number
  callCount: number
  textCount: number
  emailCount: number
  lastContactedAt: Date | string | null
  companies: ReadonlyArray<RowCompany>
  createdAt: Date | string
}

const COLUMNS: CsvColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Kind', value: (r) => r.kind },
  { header: 'Status', value: (r) => r.status },
  { header: 'Slug', value: (r) => r.slug },
  { header: 'Description', value: (r) => r.description ?? '' },
  { header: 'Email', value: (r) => r.contactEmail ?? '' },
  { header: 'Phone', value: (r) => r.contactPhone ?? '' },
  { header: 'Website', value: (r) => r.website ?? '' },
  { header: 'City', value: (r) => r.city ?? '' },
  { header: 'Country', value: (r) => r.country ?? '' },
  { header: 'Contacts', value: (r) => r.contactCount },
  { header: 'Students', value: (r) => r.studentCount },
  { header: 'Hours contracted', value: (r) => r.hoursContracted },
  { header: 'Hours delivered', value: (r) => r.hoursDelivered },
  // Pence → pounds at the boundary; CLAUDE.md §19 keeps the in-app figure
  // as integer minor units.
  {
    header: 'Amount paid (GBP)',
    value: (r) => (r.amountPaidMinor / 100).toFixed(2),
  },
  { header: 'Calls', value: (r) => r.callCount },
  { header: 'Texts', value: (r) => r.textCount },
  { header: 'Emails', value: (r) => r.emailCount },
  {
    header: 'Last contacted',
    value: (r) => (r.lastContactedAt ? new Date(r.lastContactedAt) : ''),
  },
  { header: 'Companies', value: (r) => r.companies.map((c) => c.name).join(' · ') },
  { header: 'Created at', value: (r) => (r.createdAt ? new Date(r.createdAt) : '') },
]

type Status = 'prospect' | 'active' | 'paused' | 'churned'

interface Props {
  kind: 'school' | 'partnership'
  statuses?: Status[]
  q?: string
}

export function AccountsExportButton({ kind, statuses, q }: Props) {
  const utils = trpc.useUtils()
  const recordExport = trpc.audit.recordExport.useMutation()
  async function getRows(): Promise<Row[]> {
    const data = await utils.businessAccount.list.fetch({
      kind,
      ...(statuses && statuses.length > 0 ? { statuses } : {}),
      ...(q ? { q } : {}),
      includeArchived: false,
    })
    return data
  }
  function filterSummary(): string {
    const parts = [`kind ${kind}`]
    if (statuses?.length) parts.push(`status ${statuses.join(',')}`)
    if (q) parts.push(`search "${q}"`)
    return parts.join('; ')
  }
  return (
    <CsvExportButton
      getRows={getRows}
      columns={COLUMNS}
      fileNameBase={`accounts_${kind}`}
      onExported={(rowCount) =>
        recordExport.mutate({ kind: 'account', rowCount, filterSummary: filterSummary() })
      }
    />
  )
}
