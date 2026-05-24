// Contact detail page. RSC: header pre-renders, timeline streams.
// The "Add note" form is a client island that revalidates on success.

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { createServerCaller } from '@/lib/trpc/server'

import { SendPaymentLinkButton } from '@/components/finance/SendPaymentLinkButton'

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
              <Link href={`/contacts?familyId=${contact.family.id}`} className="text-primary-700 hover:underline">
                Family: {contact.family.name ?? contact.family.id}
              </Link>
            )}
            {contact.isMinor && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                Minor
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
        {contact.family && (
          <SendPaymentLinkButton familyId={contact.family.id} contactId={contact.id} />
        )}
        <Link
          href={`/finance/refunds/new?contactId=${contact.id}`}
          className="inline-flex items-center rounded-md bg-neutral-100 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200 h-8"
        >
          Issue refund
        </Link>
        {contact.family ? (
          <Link
            href={`/contacts/families/${contact.family.id}`}
            className="inline-flex items-center rounded-md bg-neutral-100 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200 h-8"
          >
            Open family
          </Link>
        ) : (
          <span className="text-xs text-neutral-500">
            No family linked. Use Contacts list bulk actions to create one.
          </span>
        )}
      </div>

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
