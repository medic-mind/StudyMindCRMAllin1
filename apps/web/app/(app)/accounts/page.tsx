// B2B accounts (schools + partnerships). Tabbed list of tracked
// organisations. CLAUDE.md §26 (RSC), §20.1 (view-by-all).

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'
import { AccountsList } from './AccountsList'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ kind?: string; status?: string; q?: string }>
}

const KIND_LABELS: Record<string, string> = {
  school: 'Schools',
  partnership: 'Partnerships',
}

export default async function AccountsPage({ searchParams }: Props) {
  const params = await searchParams
  const kind: 'school' | 'partnership' =
    params.kind === 'partnership' ? 'partnership' : 'school'
  const caller = await createServerCaller()
  const accounts = await caller.businessAccount.list({
    kind,
    includeArchived: false,
    q: params.q?.trim() ? params.q.trim() : undefined,
    ...(params.status === 'prospect' ||
    params.status === 'active' ||
    params.status === 'paused' ||
    params.status === 'churned'
      ? { status: params.status }
      : {}),
  })

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="B2B partnerships and schools we work with"
        breadcrumbs={[{ label: 'Accounts', href: '/accounts' }]}
      />
      <PageBody>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Account kind"
            className="inline-flex rounded-md border border-neutral-200 bg-white p-0.5 shadow-card"
          >
            {(['school', 'partnership'] as const).map((k) => {
              const active = kind === k
              return (
                <Link
                  key={k}
                  role="tab"
                  aria-selected={active}
                  href={`/accounts?kind=${k}`}
                  className={
                    active
                      ? 'rounded px-3 py-1.5 text-sm font-medium text-primary-800 bg-primary-50'
                      : 'rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50'
                  }
                >
                  {KIND_LABELS[k]}
                </Link>
              )
            })}
          </div>
        </div>
        <AccountsList kind={kind} accounts={accounts} />
      </PageBody>
    </>
  )
}
