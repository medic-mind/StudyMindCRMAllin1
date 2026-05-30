// Export the contacts list to CSV. Re-fetches in 100-row pages from
// `contact.list` until the cursor runs out, then hands the rows to the
// shared `<CsvExportButton>`. Honours the current filters (search + company)
// so the CSV matches what's on screen, not the unfiltered universe.

'use client'

import { useState } from 'react'

import { CsvExportButton } from '@/components/ui/csv-export-button'
import { trpc } from '@/lib/trpc/client'
import type { CsvColumn } from '@/lib/csv'

interface Row {
  id: string
  displayName: string
  email: string | null
  phoneE164: string | null
  kind: string
  familyName: string | null
  companyNames: string
  lastInteractionAt: Date | string | null
}

const COLUMNS: CsvColumn<Row>[] = [
  { header: 'Display name', value: (r) => r.displayName },
  { header: 'Email', value: (r) => r.email ?? '' },
  { header: 'Phone (E.164)', value: (r) => r.phoneE164 ?? '' },
  { header: 'Type', value: (r) => r.kind },
  { header: 'Family', value: (r) => r.familyName ?? '' },
  { header: 'Companies', value: (r) => r.companyNames },
  {
    header: 'Last interaction at',
    value: (r) => (r.lastInteractionAt ? new Date(r.lastInteractionAt) : ''),
  },
]

interface Props {
  q?: string
  companyId?: string
}

const MAX_ROWS = 5000

export function ContactsExportButton({ q, companyId }: Props) {
  const utils = trpc.useUtils()
  const [pulling, setPulling] = useState(false)

  async function getRows(): Promise<Row[]> {
    setPulling(true)
    try {
      const all: Row[] = []
      let cursor: { id: string; createdAt: Date } | undefined
      // Loop until the cursor is exhausted or we hit the safety cap.
      for (let i = 0; i < MAX_ROWS / 100 + 1; i += 1) {
        const page = await utils.contact.list.fetch({
          q,
          companyId,
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
            familyName: c.familyName ?? null,
            companyNames: c.companies.map((cc) => cc.name).join(' · '),
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
    />
  )
}
