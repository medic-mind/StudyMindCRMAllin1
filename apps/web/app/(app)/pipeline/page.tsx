// Pipeline page. CLAUDE.md §6.4 (Family lifecycle), §26 (RSC by default).
// Stages render as columns; transitions are explicit — never silent.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

type FamilyState = 'lead' | 'trial' | 'active' | 'at_risk' | 'churned'

interface StageDef {
  state: FamilyState
  label: string
  borderClass: string
  cardLeftBorder: string
  badgeTone: BadgeTone
}

const STAGES: ReadonlyArray<StageDef> = [
  {
    state: 'lead',
    label: 'Lead',
    borderClass: 'border-t-2 border-t-neutral-400',
    cardLeftBorder: 'border-l-4 border-l-neutral-300',
    badgeTone: 'neutral',
  },
  {
    state: 'trial',
    label: 'Trial',
    borderClass: 'border-t-2 border-t-primary-400',
    cardLeftBorder: 'border-l-4 border-l-primary-400',
    badgeTone: 'info',
  },
  {
    state: 'active',
    label: 'Active',
    borderClass: 'border-t-2 border-t-emerald-500',
    cardLeftBorder: 'border-l-4 border-l-emerald-500',
    badgeTone: 'success',
  },
  {
    state: 'at_risk',
    label: 'At risk',
    borderClass: 'border-t-2 border-t-amber-500',
    cardLeftBorder: 'border-l-4 border-l-amber-500',
    badgeTone: 'warn',
  },
  {
    state: 'churned',
    label: 'Churned',
    borderClass: 'border-t-2 border-t-red-400',
    cardLeftBorder: 'border-l-4 border-l-red-400',
    badgeTone: 'danger',
  },
]

export default async function PipelinePage() {
  const caller = await createServerCaller()
  const groups = await caller.family.pipeline.list({ perStageLimit: 50 })

  const visibleFamilyIds = STAGES.flatMap(({ state }) =>
    (groups[state] ?? []).map((f) => f.id),
  )
  const recentTransitions = await caller.family.pipeline.recentTransitions({
    familyIds: visibleFamilyIds,
    limit: 5,
  })
  const now = new Date()

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle="Family lifecycle stages. Transitions are explicit and audited — open a family to change its state."
      />
      <PageBody>
        {recentTransitions.length > 0 ? (
          <aside className="rounded-lg border border-neutral-200 bg-white p-3 text-xs shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Recent transitions
            </h2>
            <ul className="mt-2 space-y-0.5">
              {recentTransitions.map((t) => (
                <li
                  key={t.id}
                  className="flex justify-between gap-2 text-neutral-600"
                >
                  <Link
                    href={`/contacts/families/${t.familyId}`}
                    className="font-mono text-neutral-700 hover:text-primary-700 hover:underline"
                  >
                    {t.summary ?? 'state changed'}
                  </Link>
                  <time
                    dateTime={t.occurredAt.toString()}
                    className="font-mono tabular-nums text-neutral-500"
                  >
                    {formatRelativeTime(new Date(t.occurredAt), now)}
                  </time>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
          {STAGES.map(({ state, label, borderClass, cardLeftBorder, badgeTone }) => {
            const items = groups[state] ?? []
            return (
              <section
                key={state}
                className={`flex flex-col rounded-lg border border-neutral-200 bg-white shadow-sm ${borderClass}`}
              >
                <header className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
                  <h2 className="text-sm font-semibold text-neutral-800">
                    {label}
                  </h2>
                  <Badge tone={badgeTone}>{items.length}</Badge>
                </header>
                {items.length === 0 ? (
                  <div className="p-4 text-center text-xs text-neutral-500">
                    No families in this stage.
                  </div>
                ) : (
                  <ul className="divide-y divide-neutral-100">
                    {items.map((f) => {
                      const isHighChurn =
                        typeof f.churnScore === 'number' && f.churnScore >= 0.7
                      return (
                        <li
                          key={f.id}
                          className={`p-3 text-sm ${cardLeftBorder} bg-white`}
                        >
                          <Link
                            href={`/contacts/families/${f.id}`}
                            className="block min-w-0 truncate font-medium text-neutral-900 hover:text-primary-700 hover:underline"
                          >
                            {f.name ?? f.id}
                          </Link>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            <Badge tone="neutral">{f.billingParty}</Badge>
                            {typeof f.churnScore === 'number' ? (
                              <Badge tone={isHighChurn ? 'danger' : 'neutral'}>
                                churn {f.churnScore.toFixed(2)}
                              </Badge>
                            ) : null}
                          </div>
                          <p className="mt-1.5 font-mono text-[10px] tabular-nums text-neutral-500">
                            {formatRelativeTime(new Date(f.updatedAt), now)}
                          </p>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </PageBody>
    </>
  )
}
