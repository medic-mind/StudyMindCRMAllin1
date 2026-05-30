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
  { header: 'Companies', value: (r) => r.companies.map((c) => c.name).join(' · ') },
  { header: 'Created at', value: (r) => (r.createdAt ? new Date(r.createdAt) : '') },
]

interface Props {
  kind: 'school' | 'partnership'
  status?: 'prospect' | 'active' | 'paused' | 'churned'
  q?: string
}

export function AccountsExportButton({ kind, status, q }: Props) {
  const utils = trpc.useUtils()
  async function getRows(): Promise<Row[]> {
    const data = await utils.businessAccount.list.fetch({
      kind,
      ...(status ? { status } : {}),
      ...(q ? { q } : {}),
      includeArchived: false,
    })
    return data
  }
  return (
    <CsvExportButton
      getRows={getRows}
      columns={COLUMNS}
      fileNameBase={`accounts_${kind}`}
    />
  )
}
