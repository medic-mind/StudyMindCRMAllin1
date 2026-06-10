// B2B accounts (schools + B2B partners). Tabbed list of tracked
// organisations, plus the Unsorted tray for accounts imported from the B2B
// Invoices Platform that still need classifying. CLAUDE.md §26 (RSC).

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'
import { AccountsExportButton } from './AccountsExportButton'
import { AccountsList } from './AccountsList'
import { UnsortedTray } from './UnsortedTray'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{
    kind?: string
    status?: string
    q?: string
    labelIds?: string
    archived?: string
  }>
}

// UI labels. "B2B Partner" replaces the old "Partnership" wording everywhere;
// the underlying enum value stays `partnership` (forward-only, CLAUDE.md §19).
const KIND_LABELS: Record<string, string> = {
  school: 'Schools',
  partnership: 'B2B Partners',
}

const STATUS_VALUES = ['prospect', 'active', 'paused', 'churned'] as const
type AccountStatus = (typeof STATUS_VALUES)[number]

export default async function AccountsPage({ searchParams }: Props) {
  const params = await searchParams
  const kind: 'school' | 'partnership' = params.kind === 'partnership' ? 'partnership' : 'school'
  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  const labelIds = params.labelIds
    ? params.labelIds.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined
  // Status is now multi-select (comma-joined in the URL).
  const statuses = params.status
    ? params.status
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is AccountStatus => (STATUS_VALUES as ReadonlyArray<string>).includes(s))
    : []
  const caller = await createServerCaller()
  const [accounts, unsortedCount] = await Promise.all([
    caller.businessAccount.list({
      kind,
      includeArchived: params.archived === '1',
      q: params.q?.trim() ? params.q.trim() : undefined,
      ...(labelIds && labelIds.length > 0 ? { labelIds } : {}),
      ...(statuses.length > 0 ? { statuses } : {}),
    }),
    caller.businessAccount.unsortedCount(),
  ])

  return (
    <>
      <PageHeader
        title="B2B / Schools"
        subtitle="Schools and B2B partners we work with"
        breadcrumbs={[{ label: 'B2B / Schools', href: '/accounts' }]}
        actions={
          <AccountsExportButton
            kind={kind}
            q={params.q?.trim() ? params.q.trim() : undefined}
            statuses={statuses}
          />
        }
      />
      <PageBody>
        {unsortedCount > 0 && <UnsortedTray initialCount={unsortedCount} />}
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
        <AccountsList kind={kind} accounts={accounts} role={role} />
      </PageBody>
    </>
  )
}
