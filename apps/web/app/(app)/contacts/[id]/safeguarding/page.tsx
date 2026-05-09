// Raise-a-concern form — agent-facing client island.
// CLAUDE.md §42.1.

import { RaiseConcernForm } from './RaiseConcernForm'

export default async function SafeguardingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Raise safeguarding concern</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Concerns are encrypted at rest and routed to the on-duty DSL. Be specific;
        avoid speculation. CLAUDE.md §42.
      </p>
      <div className="mt-6">
        <RaiseConcernForm contactId={id} />
      </div>
    </div>
  )
}
