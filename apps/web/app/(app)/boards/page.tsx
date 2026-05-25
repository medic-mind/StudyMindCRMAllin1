// Boards list. ADR 0018. Lists active boards with card counts; CEO and
// Senior Manager can create a new board. CLAUDE.md §26 (RSC), §20.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { NewBoardButton } from './NewBoardButton'

export const dynamic = 'force-dynamic'

const CAN_MANAGE = new Set(['ceo', 'senior_manager'])

export default async function BoardsPage() {
  const me = await getCurrentUser()
  const canManage = CAN_MANAGE.has(me?.role ?? 'virtual_assistant')

  const caller = await createServerCaller()
  const boards = await caller.board.list()

  return (
    <>
      <PageHeader
        title="Boards"
        subtitle="Each board is its own pipeline with its own columns and cards. Every change is audited."
        actions={canManage ? <NewBoardButton /> : null}
      />
      <PageBody>
        {boards.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-600">
            No boards yet.{' '}
            {canManage
              ? 'Create your first board to start tracking prospects.'
              : 'Ask an administrator to create the first board.'}
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {boards.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/boards/${b.id}`}
                  className="flex h-full flex-col rounded-lg border border-neutral-200 bg-white p-4 shadow-sm transition hover:border-primary-300 hover:shadow"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="truncate text-sm font-semibold text-neutral-900">{b.name}</h2>
                    {b.isDefault ? <Badge tone="info">Default</Badge> : null}
                  </div>
                  {b.description ? (
                    <p className="mt-1 line-clamp-2 text-xs text-neutral-600">{b.description}</p>
                  ) : null}
                  <p className="mt-3 font-mono text-[11px] tabular-nums text-neutral-500">
                    {b.cardCount} {b.cardCount === 1 ? 'card' : 'cards'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  )
}
