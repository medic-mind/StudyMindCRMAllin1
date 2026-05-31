// /mail — the email workspace (ADR 0021 Phase 4). A dedicated, account-aware
// view of the unified email inbox built on the Conversation head (provider=
// 'email'). Rows open the existing conversation thread view, which renders the
// full email thread (ADR 0021 Phase 3b). Reading-first v1: compose / reply from
// here lands with the two-way-sync phase. CLAUDE.md §14, §26.

import Link from 'next/link'
import { TRPCError } from '@trpc/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { MailIcon } from '@/components/ui/icon'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

import { LiveUpdates } from '../inbox/conversations/LiveUpdates'

type FilterValue = 'all' | 'unread'

export default async function MailPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; filter?: string }>
}) {
  const params = await searchParams
  const filter: FilterValue = params.filter === 'unread' ? 'unread' : 'all'
  const accountId = typeof params.account === 'string' ? params.account : null

  const caller = await createServerCaller()
  let accounts: Awaited<ReturnType<typeof caller.mail.accounts>> = []
  let items: Awaited<ReturnType<typeof caller.mail.threads.list>>['items'] = []
  let forbidden = false
  try {
    accounts = await caller.mail.accounts()
    const res = await caller.mail.threads.list({
      mailAccountId: accountId,
      filter,
      limit: 50,
    })
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
        <PageHeader title="Mail" subtitle="Email workspace" />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need a staff role to view mail.
          </p>
        </PageBody>
      </>
    )
  }

  const now = new Date()
  const qs = (next: { account?: string | null; filter?: FilterValue }) => {
    const sp = new URLSearchParams()
    const acc = next.account === undefined ? accountId : next.account
    const f = next.filter ?? filter
    if (acc) sp.set('account', acc)
    if (f !== 'all') sp.set('filter', f)
    const s = sp.toString()
    return s ? `/mail?${s}` : '/mail'
  }

  return (
    <>
      <PageHeader
        title="Mail"
        subtitle="Your email, across every connected account — kept in sync with Gmail as messages land."
      />
      <PageBody>
        <LiveUpdates />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_1fr]">
          {/* Folder / account rail */}
          <aside className="flex flex-col gap-4">
            <div>
              <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                Folders
              </h2>
              <nav className="flex flex-col gap-0.5" aria-label="Mail folders">
                <Link
                  href={qs({ filter: 'all' })}
                  aria-current={filter === 'all' ? 'page' : undefined}
                  className={
                    filter === 'all'
                      ? 'rounded-md bg-primary-50 px-2.5 py-1.5 text-sm font-medium text-primary-800'
                      : 'rounded-md px-2.5 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100'
                  }
                >
                  All mail
                </Link>
                <Link
                  href={qs({ filter: 'unread' })}
                  aria-current={filter === 'unread' ? 'page' : undefined}
                  className={
                    filter === 'unread'
                      ? 'rounded-md bg-primary-50 px-2.5 py-1.5 text-sm font-medium text-primary-800'
                      : 'rounded-md px-2.5 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100'
                  }
                >
                  Unread
                </Link>
              </nav>
            </div>

            <div>
              <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                Accounts
              </h2>
              <nav className="flex flex-col gap-0.5" aria-label="Mail accounts">
                <Link
                  href={qs({ account: null })}
                  aria-current={!accountId ? 'page' : undefined}
                  className={
                    !accountId
                      ? 'rounded-md bg-neutral-900 px-2.5 py-1.5 text-sm font-medium text-white'
                      : 'rounded-md px-2.5 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100'
                  }
                >
                  All accounts
                </Link>
                {accounts.map((a) => (
                  <Link
                    key={a.id}
                    href={qs({ account: a.id })}
                    aria-current={accountId === a.id ? 'page' : undefined}
                    className={
                      accountId === a.id
                        ? 'truncate rounded-md bg-neutral-900 px-2.5 py-1.5 text-sm font-medium text-white'
                        : 'truncate rounded-md px-2.5 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100'
                    }
                    title={a.address}
                  >
                    {a.displayName ?? a.address}
                  </Link>
                ))}
                {accounts.length === 0 ? (
                  <Link
                    href="/settings/email-accounts"
                    className="rounded-md px-2.5 py-1.5 text-xs text-primary-700 hover:bg-neutral-100"
                  >
                    Connect an account…
                  </Link>
                ) : null}
              </nav>
            </div>
          </aside>

          {/* Thread list */}
          <section>
            {items.length === 0 ? (
              <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-sm">
                <MailIcon size={24} className="mx-auto text-neutral-300" />
                <p className="mt-2 text-sm font-medium text-neutral-700">
                  {filter === 'unread'
                    ? 'No unread email.'
                    : 'No email here yet.'}
                </p>
                <p className="mt-1 text-sm text-neutral-500">
                  Email synced from your connected accounts appears here
                  automatically. Manage accounts in{' '}
                  <Link
                    href="/settings/email-accounts"
                    className="text-primary-700 underline"
                  >
                    Settings → Email accounts
                  </Link>
                  .
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white shadow-sm">
                {items.map((m) => (
                  <li key={m.id} className="transition hover:bg-neutral-50">
                    <Link
                      href={`/inbox/conversations/${m.id}`}
                      className="flex items-start justify-between gap-4 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-neutral-100"
                            aria-hidden
                          >
                            <MailIcon size={14} className="text-primary-700" />
                          </span>
                          <span
                            className={
                              m.unreadCount > 0
                                ? 'truncate font-semibold text-neutral-900'
                                : 'truncate font-medium text-neutral-800'
                            }
                          >
                            {m.contactName ??
                              (m.contactId ? 'Contact' : 'Unmatched sender')}
                          </span>
                          {m.unreadCount > 0 ? (
                            <Badge tone="warn">{m.unreadCount} unread</Badge>
                          ) : null}
                          {m.status === 'closed' ? (
                            <Badge tone="neutral">Archived</Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 truncate pl-8 text-sm text-neutral-700">
                          {m.subject ?? '(no subject)'}
                        </p>
                        {m.accountAddress ? (
                          <p className="truncate pl-8 text-xs text-neutral-400">
                            {m.accountAddress}
                          </p>
                        ) : null}
                      </div>
                      <time
                        className="shrink-0 font-mono text-xs tabular-nums text-neutral-500"
                        dateTime={m.lastMessageAt.toISOString()}
                      >
                        {formatRelativeTime(m.lastMessageAt, now)}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </PageBody>
    </>
  )
}
