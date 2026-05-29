// B2B account detail page. RSC fetches via tRPC and renders the editable
// detail island + linked contacts. CLAUDE.md §26.

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { InvoicesPanel } from '@/components/invoices/InvoicesPanel'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { AccountEditor } from './AccountEditor'
import { AccountContacts } from './AccountContacts'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

const STATUS_TONE: Record<string, string> = {
  prospect: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  active: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  paused: 'bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200',
  churned: 'bg-red-50 text-red-700 ring-1 ring-red-200',
}

export default async function BusinessAccountDetailPage({ params }: Props) {
  const { id } = await params
  const caller = await createServerCaller()
  let account
  try {
    account = await caller.businessAccount.get({ id })
  } catch {
    notFound()
  }
  if (!account) notFound()

  return (
    <>
      <PageHeader
        title={account.name}
        subtitle={account.description ?? undefined}
        breadcrumbs={[
          { label: 'Accounts', href: '/accounts' },
          {
            label: account.kind === 'school' ? 'Schools' : 'Partnerships',
            href: `/accounts?kind=${account.kind}`,
          },
          { label: account.name, href: `/accounts/${account.id}` },
        ]}
      />
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_TONE[account.status] ?? ''}`}
          >
            {account.status}
          </span>
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {account.kind}
          </span>
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

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <AccountEditor account={account} />
          <AccountContacts account={account} />
        </div>

        <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-900">Invoices</h2>
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">
              Uploaded paperwork
            </span>
          </div>
          <InvoicesPanel
            target={{ kind: 'businessAccount', businessAccountId: account.id }}
          />
        </section>
      </div>
    </>
  )
}
