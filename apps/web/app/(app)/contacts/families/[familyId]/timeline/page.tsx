// Family-level timeline. CLAUDE.md §6.2 — every Interaction across all
// member Contacts. Cursor pagination on (occurredAt, id) (§27).

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { createServerCaller } from '@/lib/trpc/server'

import { FamilyTimeline } from './FamilyTimeline'

export const dynamic = 'force-dynamic'

export default async function FamilyTimelinePage({
  params,
}: {
  params: Promise<{ familyId: string }>
}) {
  const { familyId } = await params
  const caller = await createServerCaller()
  let detail
  try {
    detail = await caller.family.getDetail({ id: familyId })
  } catch {
    notFound()
  }

  const initial = await caller.interaction.list({ familyId, limit: 50 })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Timeline · {detail.name ?? `Family ${detail.id.slice(-6)}`}
          </h1>
          <p className="text-sm text-neutral-600">
            Every interaction across the family — emails, calls, messages,
            notes, payments, and AI insights.
          </p>
        </div>
        <Link
          href={`/contacts/families/${detail.id}`}
          className="text-sm text-neutral-700 hover:underline"
        >
          ← Back to family
        </Link>
      </div>

      <FamilyTimeline
        familyId={familyId}
        initialItems={initial.items}
        initialNextCursor={initial.nextCursor}
      />
    </div>
  )
}
