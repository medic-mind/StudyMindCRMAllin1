// Tender pipeline kanban board. CLAUDE.md §43.1, §26 (RSC by default,
// dense lists), §3 (humans confirm — no drag-and-drop, explicit "move
// state" button with a confirm dialog on the client component).

import { TRPCError } from '@trpc/server'

import { createServerCaller } from '@/lib/trpc/server'

import { TenderMoveButton } from './TenderMoveButton'

const COLUMNS = ['identified', 'drafting', 'submitted', 'shortlisted', 'awarded'] as const

const STATE_LABEL: Record<string, string> = {
  identified: 'Identified',
  drafting: 'Drafting',
  submitted: 'Submitted',
  shortlisted: 'Shortlisted',
  awarded: 'Awarded',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
}

const NEXT_STATES: Record<string, ReadonlyArray<string>> = {
  identified: ['drafting', 'withdrawn'],
  drafting: ['submitted', 'withdrawn'],
  submitted: ['shortlisted', 'rejected', 'withdrawn'],
  shortlisted: ['awarded', 'rejected', 'withdrawn'],
  awarded: [],
  rejected: [],
  withdrawn: [],
}

function formatGbp(minor: number | null): string {
  if (minor === null) return '—'
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100)
}

export default async function TendersPipelinePage() {
  const caller = await createServerCaller()
  let tenders: Awaited<ReturnType<typeof caller.tender.list>> = []
  let forbidden = false
  try {
    tenders = await caller.tender.list()
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      forbidden = true
    } else {
      throw err
    }
  }

  if (forbidden) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tenders</h1>
        <p className="mt-2 text-sm text-neutral-600">
          You need an account-lead, finance, or read-only role to view tenders.
        </p>
      </div>
    )
  }

  const live = tenders.filter((t) => COLUMNS.includes(t.state as (typeof COLUMNS)[number]))
  const closed = tenders.filter((t) => t.state === 'rejected' || t.state === 'withdrawn')

  const grouped = new Map<string, typeof live>()
  for (const col of COLUMNS) grouped.set(col, [])
  for (const t of live) grouped.get(t.state)?.push(t)

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Tenders</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Active LA tender pipeline. Move states explicitly — no drag-and-drop.
        Drafts marked SEMH/EHCP-heavy require both account-lead and DSL signoff
        before submission.
      </p>

      {tenders.length === 0 ? (
        <div className="mt-8 rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-700">
          No tenders yet. Create one from the LA contracts dashboard or via
          the tender API to start tracking the bid.
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = grouped.get(col) ?? []
            return (
              <section
                key={col}
                className="flex flex-col rounded-lg border border-neutral-200 bg-neutral-50 p-3"
              >
                <header className="flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-700">
                    {STATE_LABEL[col]}
                  </h2>
                  <span className="text-xs text-neutral-500">{items.length}</span>
                </header>
                <ul className="mt-3 space-y-2">
                  {items.map((t) => (
                    <li
                      key={t.id}
                      className="rounded-md border border-neutral-200 bg-white p-2 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-neutral-900">{t.name}</div>
                          <div className="text-xs text-neutral-600">{t.laName}</div>
                        </div>
                        {t.isSemhOrEhcpHeavy ? (
                          <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                            SEMH / EHCP
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-neutral-500">
                        <span className="font-mono tabular-nums">
                          {formatGbp(t.contractValueMinor)}
                        </span>
                        {t.dueAt ? (
                          <span>Due {t.dueAt.toISOString().slice(0, 10)}</span>
                        ) : null}
                      </div>
                      {NEXT_STATES[col]!.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {NEXT_STATES[col]!.map((next) => (
                            <TenderMoveButton
                              key={next}
                              tenderId={t.id}
                              from={col}
                              to={next}
                              label={STATE_LABEL[next] ?? next}
                            />
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}

      {closed.length > 0 ? (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm font-medium text-neutral-700">
            Closed ({closed.length})
          </summary>
          <ul className="mt-2 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
            {closed.map((t) => (
              <li key={t.id} className="flex items-center justify-between p-3 text-sm">
                <span>
                  {t.name} <span className="text-neutral-500">— {t.laName}</span>
                </span>
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs">
                  {STATE_LABEL[t.state] ?? t.state}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
