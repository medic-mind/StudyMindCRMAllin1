// Board settings. ADR 0018. CEO + Senior Manager only. Rename the board,
// manage its stages, configure tick/x quick-action target stages, and manage
// labels. CLAUDE.md §20 (server also gates every mutation).

import { notFound, redirect } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { BoardSettings } from './BoardSettings'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ boardId: string }>
}

export default async function BoardSettingsPage({ params }: PageProps) {
  const { boardId } = await params
  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  if (role !== 'ceo' && role !== 'senior_manager') {
    redirect(`/boards/${boardId}`)
  }

  const caller = await createServerCaller()
  let board
  try {
    board = await caller.board.get({ id: boardId })
  } catch {
    notFound()
  }
  const [stages, labels] = await Promise.all([
    caller.board.stages.list({ boardId }),
    caller.label.list(),
  ])

  return (
    <>
      <PageHeader
        title={`${board.name} — settings`}
        subtitle="Rename the board, manage its stages and labels, and set the quick-action target stages. Every change is audited."
        breadcrumbs={[
          { label: 'Boards', href: '/boards' },
          { label: board.name, href: `/boards/${boardId}` },
        ]}
      />
      <PageBody>
        <BoardSettings
          board={{
            id: board.id,
            name: board.name,
            description: board.description,
            tickActionStageId: board.tickActionStageId,
            xActionStageId: board.xActionStageId,
          }}
          stages={stages}
          labels={labels}
        />
      </PageBody>
    </>
  )
}
