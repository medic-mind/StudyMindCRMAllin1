// B2B account detail page. RSC fetches via tRPC and renders the editable
// detail island + linked contacts. CLAUDE.md §26.

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { AccountInvoicingPanel } from '@/components/invoicing/AccountInvoicingPanel'
import { InvoicesPanel } from '@/components/invoices/InvoicesPanel'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { getCurrentUser } from '@/lib/auth/server'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'
import { accountStatusTone } from '@/lib/ui/status-tone'

import { SlackSection } from '../../contacts/[id]/sections/SlackSection'

import { NewTaskDialog } from '../../tasks/NewTaskDialog'

import { AccountEditor } from './AccountEditor'
import { AccountContacts } from './AccountContacts'
import { AccountStatsBand } from './AccountStatsBand'
import { AccountStudents } from './AccountStudents'
import { AddAccountNote } from './AddAccountNote'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}


const INVOICING_WRITE_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])
const INVOICING_MARK_PAID_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

export default async function BusinessAccountDetailPage({ params }: Props) {
  const { id } = await params
  const caller = await createServerCaller()
  const me = await getCurrentUser()
  let account
  try {
    account = await caller.businessAccount.get({ id })
  } catch {
    notFound()
  }
  if (!account) notFound()

  const canInvoiceWrite = Boolean(me && INVOICING_WRITE_ROLES.has(me.role))
  const canInvoiceMarkPaid = Boolean(me && INVOICING_MARK_PAID_ROLES.has(me.role))

  // Notes / tasks / activity / Slack — parity with the customer view.
  const [notes, tasks, activity, slackMentions] = await Promise.all([
    caller.businessAccount.notes.list({ accountId: id, limit: 50 }),
    caller.businessAccount.tasks.list({ accountId: id }),
    caller.businessAccount.activity.list({ accountId: id, limit: 30 }),
    caller.businessAccount.slackMentions.list({ accountId: id, limit: 25 }),
  ])

  const fmt = (d: Date | string) =>
    new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d))

  return (
    <>
      <PageHeader
        title={account.name}
        subtitle={account.description ?? undefined}
        breadcrumbs={[
          { label: 'Accounts', href: '/accounts' },
          {
            label: account.kind === 'school' ? 'Schools' : 'B2B Partners',
            href: `/accounts?kind=${account.kind}`,
          },
          { label: account.name, href: `/accounts/${account.id}` },
        ]}
      />
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={accountStatusTone(account.status)} className="uppercase tracking-wide">
            {account.status}
          </Badge>
          <span className="text-xs uppercase tracking-wide text-neutral-500">{account.kind}</span>
          {account.archived && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
              Archived
            </span>
          )}
          {account.website && (
            <Link
              href={account.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary-700 hover:underline"
            >
              {account.website}
            </Link>
          )}
        </div>

        <AccountStatsBand stats={account.stats} />

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <AccountEditor account={account} />
          <AccountContacts account={account} />
        </div>

        <AccountStudents accountId={account.id} />

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-900">Tasks</h2>
            <NewTaskDialog
              businessAccountId={account.id}
              triggerLabel="New task"
              triggerSize="sm"
            />
          </div>
          {tasks.open.length === 0 && tasks.closed.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No tasks yet — raise one against this account with “New task”.
            </p>
          ) : (
            <ul className="space-y-2">
              {[...tasks.open, ...tasks.closed].map((t) => {
                const done = t.status === 'done' || t.status === 'cancelled'
                return (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 text-sm"
                  >
                    <span className={done ? 'text-neutral-400 line-through' : 'text-neutral-900'}>
                      {t.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-neutral-500">
                      {t.assigneeName ? <span>{t.assigneeName}</span> : null}
                      {t.dueAt ? <span>· due {fmt(t.dueAt)}</span> : null}
                      <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                        {t.status.replace(/_/g, ' ')}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-neutral-900">Notes</h2>
          <AddAccountNote accountId={account.id} />
          {notes.length > 0 ? (
            <ol className="mt-3 space-y-2">
              {notes.map((n) => (
                <li
                  key={n.id}
                  className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm"
                >
                  <div className="text-xs text-neutral-500">{fmt(n.occurredAt)}</div>
                  <p className="mt-1 whitespace-pre-wrap text-neutral-900">{n.body}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">No notes yet — add the first above.</p>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-900">Invoicing</h2>
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">
              B2B Invoices Platform
            </span>
          </div>
          <AccountInvoicingPanel
            target={{ kind: 'businessAccount', businessAccountId: account.id }}
            canWrite={canInvoiceWrite}
            canMarkPaid={canInvoiceMarkPaid}
            defaultClientType={account.kind === 'school' ? 'school' : 'uk_b2b'}
          />
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-900">Invoice files</h2>
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">
              Uploaded paperwork
            </span>
          </div>
          <InvoicesPanel target={{ kind: 'businessAccount', businessAccountId: account.id }} />
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-900">Slack mentions</h2>
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">
              From watched channels
            </span>
          </div>
          <SlackSection
            mentions={slackMentions}
            emptyHint="No Slack mentions yet — messages from watched channels that name this school/partner (or one of its linked contacts) will appear here."
          />
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-neutral-900">Activity</h2>
          {activity.length === 0 ? (
            <p className="text-sm text-neutral-500">
              Notes and tasks raised against this account will appear here.
            </p>
          ) : (
            <ol className="space-y-2">
              {activity.map((a) => (
                <li key={a.id} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-600">
                    {a.type.replace(/_/g, ' ')}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-neutral-900">{a.summary ?? '—'}</span>
                    <span className="text-xs text-neutral-500">{fmt(a.occurredAt)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  )
}
