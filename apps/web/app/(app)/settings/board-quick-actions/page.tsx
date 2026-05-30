// Settings → Board quick actions. A landing page that lists every board
// and links into its settings, where the per-board quick-action catalogue
// lives. Manager+ (the board settings page enforces its own gate too).
// This page exists so the quick-action admin is discoverable from Settings
// rather than only via Boards → a board → Settings.

import Link from 'next/link'

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Board quick actions', href: '/settings/board-quick-actions' },
]

export default async function BoardQuickActionsSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Board quick actions" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">Restricted to Manager and above.</p>
        </PageBody>
      </>
    )
  }

  const caller = await createServerCaller()
  const boards = await caller.board.list()

  return (
    <>
      <PageHeader
        title="Board quick actions"
        subtitle="Pick a board to manage its per-card quick-action buttons (Called once, Called twice, Invalid number…)."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        {boards.length === 0 ? (
          <p className="text-sm text-neutral-600">
            No boards yet. Create one from{' '}
            <Link href="/boards" className="text-primary-700 underline">
              Boards
            </Link>
            .
          </p>
        ) : (
          <ul className="space-y-2">
            {boards.map((b) => (
              <li
                key={b.id}
                className="rounded-lg border border-neutral-200 bg-white shadow-card transition-shadow hover:shadow-card-hover"
              >
                <Link
                  href={`/boards/${b.id}/settings`}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-neutral-900">{b.name}</h3>
                      {b.isDefault && (
                        <span className="rounded-full bg-primary-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-700">
                          Default
                        </span>
                      )}
                    </div>
                    {b.description && (
                      <p className="mt-0.5 text-xs text-neutral-600">{b.description}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs font-medium text-primary-700">
                    Manage buttons →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  )
}
