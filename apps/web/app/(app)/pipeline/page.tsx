// Pipeline page. CLAUDE.md §6.4 (Family lifecycle), §26 (RSC by default).
// Stages render as columns; transitions are explicit — never silent.

import Link from 'next/link'

import { createServerCaller } from '@/lib/trpc/server'

import { PipelineTransitionMenu } from './PipelineTransitionMenu'

const STAGES = [
  { state: 'lead', label: 'Lead' },
  { state: 'trial', label: 'Trial' },
  { state: 'active', label: 'Active' },
  { state: 'at_risk', label: 'At risk' },
  { state: 'churned', label: 'Churned' },
] as const

export default async function PipelinePage() {
  const caller = await createServerCaller()
  const groups = await caller.family.pipeline.list({ perStageLimit: 50 })

  // Pull the most recent state-change interactions across visible families.
  const visibleFamilyIds = STAGES.flatMap(({ state }) =>
    (groups[state] ?? []).map((f) => f.id),
  )
  const recentTransitions = await caller.family.pipeline.recentTransitions({
    familyIds: visibleFamilyIds,
    limit: 5,
  })

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Families grouped by lifecycle state. Transitions are explicit and
        audited — open a family to change its state.
      </p>

      {recentTransitions.length > 0 ? (
        <aside className="mt-4 rounded border border-neutral-200 bg-neutral-50 p-3 text-xs">
          <h2 className="font-semibold text-neutral-700">Recent transitions</h2>
          <ul className="mt-1 space-y-0.5">
            {recentTransitions.map((t) => (
              <li key={t.id} className="flex justify-between gap-2 text-neutral-600">
                <Link
                  href={`/contacts/families/${t.familyId}`}
                  className="font-mono hover:underline"
                >
                  {t.summary ?? 'state changed'}
                </Link>
                <time dateTime={t.occurredAt.toString()} className="tabular-nums">
                  {new Date(t.occurredAt).toLocaleString('en-GB', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </time>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {STAGES.map(({ state, label }) => {
          const items = groups[state] ?? []
          return (
            <section
              key={state}
              className="flex flex-col rounded-lg border border-neutral-200 bg-neutral-50"
            >
              <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
                <h2 className="text-sm font-semibold text-neutral-800">{label}</h2>
                <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs text-neutral-700 tabular-nums">
                  {items.length}
                </span>
              </header>
              {items.length === 0 ? (
                <div className="p-3 text-xs text-neutral-500">
                  No families in this stage yet.
                </div>
              ) : (
                <ul className="divide-y divide-neutral-200">
                  {items.map((f) => (
                    <li key={f.id} className="p-3 text-sm">
                      <Link
                        href={`/contacts/families/${f.id}`}
                        className="font-medium text-neutral-900 hover:underline"
                      >
                        {f.name ?? f.id}
                      </Link>
                      <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                        <span>{f.billingParty}</span>
                        {typeof f.churnScore === 'number' ? (
                          <span className="font-mono tabular-nums">
                            churn {f.churnScore.toFixed(2)}
                          </span>
                        ) : null}
                      </div>
                      <PipelineTransitionMenu
                        familyId={f.id}
                        currentState={state}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
