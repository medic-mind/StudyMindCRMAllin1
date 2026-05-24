// Pipeline page. ADR 0015. CLAUDE.md §6.4 (dynamic pipeline), §26 (RSC).
//
// Columns are operator-defined PipelineStage rows ordered by `position`.
// Families are grouped by `stageId`. The per-card "Move to…" dropdown is
// only rendered for users who can call `pipeline.family.move` on the
// server — Virtual Assistants see the kanban read-only.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { getCurrentUser } from '@/lib/auth/server'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

import { MoveStageMenu } from './MoveStageMenu'
import { resolveStageColor } from './stage-color'

const CAN_MOVE_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])
const CAN_MANAGE_ROLES = new Set(['ceo', 'senior_manager'])

interface FamilyRow {
  id: string
  name: string | null
  stageId: string | null
  billingParty: string
  churnScore: number | null
  updatedAt: Date
}

export default async function PipelinePage() {
  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  const canMove = CAN_MOVE_ROLES.has(role)
  const canManage = CAN_MANAGE_ROLES.has(role)

  const caller = await createServerCaller()
  const stages = await caller.pipeline.stages.list()

  // Pull a bounded slice per stage. Cap on the SQL side to keep the kanban
  // fast; bigger lists are paginated on a per-stage detail view (future).
  const PER_STAGE_LIMIT = 50
  const families = await caller.family.pipeline.list({
    perStageLimit: PER_STAGE_LIMIT,
  })
  // The legacy `family.pipeline.list` keys by FamilyState; we no longer
  // group by state here. Reduce to a single flat array, then bucket by
  // stageId below so the new ordering wins.
  // The legacy `family.pipeline.list` is keyed by FamilyState. Flatten,
  // dedupe by id (a family appears in only one state bucket), then bucket
  // by the new stageId below so the dynamic ordering wins.
  const seen = new Set<string>()
  const flat: FamilyRow[] = []
  for (const rows of Object.values(families)) {
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      flat.push({
        id: r.id,
        name: r.name,
        stageId: r.stageId ?? null,
        billingParty: r.billingParty,
        churnScore: r.churnScore,
        updatedAt: r.updatedAt,
      })
    }
  }

  const stageOptions = stages.map((s) => ({ id: s.id, name: s.name }))
  const byStage = new Map<string, FamilyRow[]>()
  for (const s of stages) byStage.set(s.id, [])
  const unassigned: FamilyRow[] = []
  for (const f of flat) {
    if (f.stageId && byStage.has(f.stageId)) {
      byStage.get(f.stageId)!.push(f)
    } else {
      unassigned.push(f)
    }
  }

  const now = new Date()

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle="Operator-managed sales stages. Move families between stages — every move is audited."
        actions={
          canManage ? (
            <Link
              href="/pipeline/manage"
              className="inline-flex h-8 items-center rounded-md bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-800"
            >
              Manage stages
            </Link>
          ) : null
        }
      />
      <PageBody>
        {stages.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-600">
            No pipeline stages yet.{' '}
            {canManage ? (
              <Link href="/pipeline/manage" className="text-primary-700 underline">
                Create the first stage
              </Link>
            ) : (
              'Ask an administrator to create the first stage.'
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
            {stages.map((stage) => {
              const items = byStage.get(stage.id) ?? []
              const colour = resolveStageColor(stage.color)
              return (
                <section
                  key={stage.id}
                  className={`flex flex-col rounded-lg border border-neutral-200 bg-white shadow-sm ${
                    stage.isClosed ? 'opacity-80' : ''
                  }`}
                  style={{ borderTop: `3px solid ${colour}` }}
                >
                  <header className="flex items-center justify-between gap-2 border-b border-neutral-100 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: colour }}
                        aria-hidden
                      />
                      <h2 className="truncate text-sm font-semibold text-neutral-800">
                        {stage.name}
                      </h2>
                      {stage.isClosed ? (
                        <Badge tone="neutral">Closed</Badge>
                      ) : null}
                    </div>
                    <Badge tone="neutral">{items.length}</Badge>
                  </header>
                  {items.length === 0 ? (
                    <div className="p-4 text-center text-xs text-neutral-500">
                      No families in {stage.name}.{' '}
                      {canMove ? (
                        <span className="text-neutral-600">Move one here.</span>
                      ) : null}
                    </div>
                  ) : (
                    <ul className="divide-y divide-neutral-100">
                      {items.map((f) => {
                        const isHighChurn =
                          typeof f.churnScore === 'number' && f.churnScore >= 0.7
                        return (
                          <li key={f.id} className="bg-white p-3 text-sm">
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
                            {canMove ? (
                              <div className="mt-2">
                                <MoveStageMenu
                                  familyId={f.id}
                                  currentStageId={stage.id}
                                  stages={stageOptions}
                                />
                              </div>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        )}

        {unassigned.length > 0 ? (
          <section className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            <h2 className="text-sm font-semibold text-amber-900">
              Unassigned families ({unassigned.length})
            </h2>
            <p className="mt-1 text-xs text-amber-800">
              These families have no pipeline stage. Open each to assign one.
            </p>
            <ul className="mt-2 divide-y divide-amber-100">
              {unassigned.slice(0, 20).map((f) => (
                <li key={f.id} className="py-1.5 text-sm">
                  <Link
                    href={`/contacts/families/${f.id}`}
                    className="text-amber-900 hover:underline"
                  >
                    {f.name ?? f.id}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </PageBody>
    </>
  )
}
