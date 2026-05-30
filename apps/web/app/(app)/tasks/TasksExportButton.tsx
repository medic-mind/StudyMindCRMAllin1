// CSV export for the tasks list. Pages through `task.list` honouring the
// current scope / status / overdue filters.

'use client'

import { CsvExportButton } from '@/components/ui/csv-export-button'
import { trpc } from '@/lib/trpc/client'
import type { CsvColumn } from '@/lib/csv'

interface Row {
  id: string
  title: string
  description: string | null
  status: string
  assigneeName: string | null
  assigneeEmail: string | null
  teamName: string | null
  contactId: string | null
  familyName: string | null
  dueAt: Date | string | null
  createdAt: Date | string
}

const COLUMNS: CsvColumn<Row>[] = [
  { header: 'Title', value: (r) => r.title },
  { header: 'Description', value: (r) => r.description ?? '' },
  { header: 'Status', value: (r) => r.status },
  { header: 'Assignee', value: (r) => r.assigneeName ?? r.assigneeEmail ?? '' },
  { header: 'Team', value: (r) => r.teamName ?? '' },
  { header: 'Family', value: (r) => r.familyName ?? '' },
  { header: 'Contact id', value: (r) => r.contactId ?? '' },
  { header: 'Due at', value: (r) => (r.dueAt ? new Date(r.dueAt) : '') },
  { header: 'Created at', value: (r) => (r.createdAt ? new Date(r.createdAt) : '') },
]

interface Props {
  scope?: 'me' | 'team' | 'all'
  teamId?: string
  status?: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
  overdue?: boolean
}

const MAX_ROWS = 5000

export function TasksExportButton({ scope, teamId, status, overdue }: Props) {
  const utils = trpc.useUtils()
  async function getRows(): Promise<Row[]> {
    const all: Row[] = []
    let cursor: { id: string; createdAt: Date } | undefined
    for (let i = 0; i < MAX_ROWS / 100 + 1; i += 1) {
      const page = await utils.task.list.fetch({
        ...(scope ? { scope } : {}),
        ...(teamId ? { teamId } : {}),
        ...(status ? { status } : {}),
        ...(overdue ? { overdue } : {}),
        cursor,
        limit: 100,
      })
      for (const t of page.items) {
        all.push({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          assigneeName: t.assigneeName,
          assigneeEmail: t.assigneeEmail,
          teamName: t.teamName ?? null,
          contactId: t.contactId,
          familyName: t.familyName,
          dueAt: t.dueAt,
          createdAt: t.createdAt,
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
  }

  return <CsvExportButton getRows={getRows} columns={COLUMNS} fileNameBase="tasks" />
}
