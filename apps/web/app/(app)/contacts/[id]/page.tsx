// Contact detail page. RSC: header pre-renders, timeline streams.
// The "Add note" form is a client island that revalidates on success.

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { createServerCaller } from '@/lib/trpc/server'

import { SendPaymentLinkButton } from '@/components/finance/SendPaymentLinkButton'
import { RestrictedAccessBanner } from '@/components/safeguarding/RestrictedAccessBanner'

import { AddNote } from './AddNote'
import { Timeline } from './Timeline'

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const caller = await createServerCaller()
  let contact
  try {
    contact = await caller.contact.get({ id })
  } catch {
    notFound()
  }
  if (!contact) notFound()

  // CLAUDE.md §42.3: restricted contacts hide their timeline from non-DSL.
  // contact.get already enforces; if we got here as non-DSL the contact is
  // not restricted. We still render the banner when isRestricted so DSLs
  // see the cue.
  if (contact.isRestricted) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">{contact.displayName}</h1>
        <RestrictedAccessBanner />
      </div>
    )
  }

  const timeline = await caller.interaction.list({ contactId: id, limit: 25 })

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{contact.displayName}</h1>
          <div className="mt-1 flex items-center gap-3 text-sm text-neutral-600">
            <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs font-medium uppercase tracking-wide">
              {contact.kind}
            </span>
            {contact.email && <span>{contact.email}</span>}
            {contact.phoneE164 && <span className="font-mono">{contact.phoneE164}</span>}
            {contact.family && (
              <Link href={`/contacts?familyId=${contact.family.id}`} className="text-blue-700 hover:underline">
                Family: {contact.family.name ?? contact.family.id}
              </Link>
            )}
            {contact.isMinor && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                Minor
              </span>
            )}
            {contact.hasSafeguardingFlag && (
              <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">
                Safeguarding flag
              </span>
            )}
          </div>
        </div>
      </div>

      {contact.family && (
        <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3">
          <SendPaymentLinkButton familyId={contact.family.id} contactId={contact.id} />
        </div>
      )}

      {contact.notes && (
        <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800">
          {contact.notes}
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <div className="mt-3">
          <AddNote contactId={contact.id} />
        </div>
        <div className="mt-6">
          <Timeline initialItems={timeline.items} initialNextCursor={timeline.nextCursor} contactId={contact.id} />
        </div>
      </div>
    </div>
  )
}
