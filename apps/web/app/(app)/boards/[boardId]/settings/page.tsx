// Board settings. ADR 0018. Rename the board, manage its stages, configure
// tick/x quick-action target stages, and manage labels. Open to every staff
// role (2026-07 — VA and above can do anything operational); the board tRPC
// mutations still gate + audit each write server-side. CLAUDE.md §20.

import { notFound } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { parseCardFace } from '@/lib/board/card-face'
import { createServerCaller } from '@/lib/trpc/server'

import { BoardCardFaceAdmin } from './BoardCardFaceAdmin'
import { BoardQuickActionsAdmin } from './BoardQuickActionsAdmin'
import { BoardSettings } from './BoardSettings'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ boardId: string }>
}

export default async function BoardSettingsPage({ params }: PageProps) {
  const { boardId } = await params
  const caller = await createServerCaller()
  let board
  try {
    board = await caller.board.get({ id: boardId })
  } catch {
    notFound()
  }
  const [stages, labels, boards] = await Promise.all([
    caller.board.stages.list({ boardId }),
    caller.label.list(),
    caller.board.list(),
  ])
  // All stages across every active board so quick actions can route off
  // to another pipeline. One extra round-trip per other board; fine for
  // an admin page.
  const allStages = (
    await Promise.all(
      boards.map(async (b) => ({
        board: b,
        stages: await caller.board.stages.list({ boardId: b.id }),
      })),
    )
  ).flatMap((g) =>
    g.stages.map((s) => ({
      id: s.id,
      name: s.name,
      boardId: g.board.id,
      boardName: g.board.name,
    })),
  )

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
        <div className="space-y-6">
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
          <BoardCardFaceAdmin
            boardId={boardId}
            initialFields={parseCardFace(board.cardFields)}
          />
          <BoardQuickActionsAdmin boardId={boardId} allStages={allStages} />
        </div>
      </PageBody>
    </>
  )
}
