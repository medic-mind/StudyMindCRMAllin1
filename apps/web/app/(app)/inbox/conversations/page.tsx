// Communication Centre — the unified customer inbox (ADR 0020 Phase 2b +
// ADR 0021/0024 email unification). CLAUDE.md §11, §14, §20, §26.
//
// Lists every customer conversation — Trengo (WhatsApp / SMS / web-chat /
// email) and Gmail email — from the first-class channel-agnostic
// `Conversation` head, not the polymorphic Interaction grouping. status /
// assignee / unread are real columns so the inbox answers "all unassigned
// open" with one indexed query. `/inbox` redirects here, so this is the
// single canonical customer inbox.

import Link from 'next/link'
import { TRPCError } from '@trpc/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { BulkConversationList } from './BulkConversationList'
import { LiveUpdates } from './LiveUpdates'

type FilterValue = 'active' | 'mine' | 'unassigned' | 'closed' | 'snoozed'

const FILTERS: ReadonlyArray<{ value: FilterValue; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'mine', label: 'Mine' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'snoozed', label: 'Snoozed' },
  { value: 'closed', label: 'Closed' },
]

function parseFilter(raw: string | string[] | undefined): FilterValue {
  const v = Array.isArray(raw) ? raw[0] : raw
  return FILTERS.some((f) => f.value === v) ? (v as FilterValue) : 'active'
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string | string[] }>
}) {
  const params = await searchParams
  const filter = parseFilter(params.filter)
  const caller = await createServerCaller()
  type Item = Awaited<ReturnType<typeof caller.inbox.conversations.list>>['items'][number]
  let items: Item[] = []
  let forbidden = false
  try {
    const res = await caller.inbox.conversations.list({ filter, limit: 50 })
    items = res.items
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      forbidden = true
    } else {
      throw err
    }
  }

  if (forbidden) {
    return (
      <>
        <PageHeader title="Conversations" subtitle="Communication Centre" />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need a staff role to view conversations.
          </p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Every customer conversation across all channels — WhatsApp, SMS, web-chat and email — with its status, assignee and unread count, kept in sync as messages land."
      />
      <PageBody>
        {/* Live SSE subscription — refreshes the list without polling
            whenever a webhook lands or the CRM itself updates the head.
            Renders nothing visible. */}
        <LiveUpdates />
        {/* One customer inbox. The legacy raw-message list was collapsed into
            this head-backed view; the only sibling is the field-edit review
            queue. */}
        <nav
          aria-label="Inbox view"
          className="mb-3 flex flex-wrap items-center gap-1"
        >
          <Link
            href="/inbox"
            aria-current="page"
            className="rounded-md bg-primary-600 px-2.5 py-1 text-xs font-medium text-white"
          >
            Conversations
          </Link>
          <Link
            href="/inbox/suggestions"
            className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            Suggestions
          </Link>
        </nav>

        <nav
          aria-label="Conversation filters"
          className="mb-3 flex flex-wrap items-center gap-1"
        >
          {FILTERS.map((f) => {
            const href =
              f.value === 'active'
                ? '/inbox/conversations'
                : `/inbox/conversations?filter=${f.value}`
            const isActive = filter === f.value
            return (
              <Link
                key={f.value}
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={
                  isActive
                    ? 'rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white'
                    : 'rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50'
                }
              >
                {f.label}
              </Link>
            )
          })}
        </nav>

        {items.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-sm">
            <p className="text-sm font-medium text-neutral-700">
              {filter === 'mine'
                ? 'No conversations assigned to you.'
                : filter === 'unassigned'
                  ? 'Nothing waiting to be picked up.'
                  : filter === 'closed'
                    ? 'No closed conversations yet.'
                    : filter === 'snoozed'
                      ? 'No conversations snoozed for later.'
                      : 'No active conversations.'}
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              Every inbound message, assignment, close and label — across
              WhatsApp, SMS, web-chat and email — updates this list
              automatically. New conversations appear as soon as they land.
            </p>
          </div>
        ) : (
          <BulkConversationList items={items} />
        )}
      </PageBody>
    </>
  )
}
