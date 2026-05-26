// Comprehensive customer view (ADR 0017). RSC loads every channel via the
// contact.channels.* tRPC procedures; client islands handle interactive
// Reply / Expand / Search controls. Each channel renders its own shape — not
// a generic Interaction list — and every section degrades gracefully when
// empty.

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { createServerCaller } from '@/lib/trpc/server'

import { SendPaymentLinkButton } from '@/components/finance/SendPaymentLinkButton'

import { NewTaskDialog } from '../../tasks/NewTaskDialog'

import { AddNote } from './AddNote'
import { Timeline } from './Timeline'
import { CallsSection } from './sections/CallsSection'
import { ChannelTiles } from './sections/ChannelTiles'
import { ContactSearchBar } from './sections/ContactSearchBar'
import { EmailSection } from './sections/EmailSection'
import { SlackSection } from './sections/SlackSection'
import { TasksSection } from './sections/TasksSection'
import { TrengoSection } from './sections/TrengoSection'

function SectionHeader({ id, title }: { id: string; title: string }): JSX.Element {
  return (
    <h2
      id={id}
      className="scroll-mt-20 border-b border-neutral-200 pb-1 text-lg font-semibold text-neutral-900"
    >
      {title}
    </h2>
  )
}

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

  // One round-trip for the KPI tiles, then per-channel lists in parallel.
  const [summary, emailThreads, calls, slackMentions, trengo, tasks, notes, timeline] =
    await Promise.all([
      caller.contact.channels.summary({ contactId: id }),
      caller.contact.channels.emailThreads({ contactId: id, limit: 25 }),
      caller.contact.channels.calls({ contactId: id, limit: 25 }),
      caller.contact.channels.slackMentions({ contactId: id, limit: 25 }),
      caller.contact.channels.trengoConversations({ contactId: id, limit: 25 }),
      caller.contact.channels.tasks({ contactId: id }),
      caller.contact.channels.notes({ contactId: id, limit: 25 }),
      caller.interaction.list({ contactId: id, limit: 25 }),
    ])

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {contact.displayName}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-neutral-600">
            <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs font-medium uppercase tracking-wide">
              {contact.kind}
            </span>
            {contact.email && <span>{contact.email}</span>}
            {contact.phoneE164 && <span className="font-mono">{contact.phoneE164}</span>}
            {contact.family && (
              <Link
                href={`/contacts/families/${contact.family.id}`}
                className="text-primary-700 hover:underline"
              >
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

      {/* Action row */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
        {contact.family && (
          <SendPaymentLinkButton familyId={contact.family.id} contactId={contact.id} />
        )}
        <Link
          href={`/finance/refunds/new?contactId=${contact.id}`}
          className="inline-flex h-8 items-center rounded-md bg-neutral-100 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
        >
          Issue refund
        </Link>
        {contact.family && (
          <Link
            href={`/contacts/families/${contact.family.id}`}
            className="inline-flex h-8 items-center rounded-md bg-neutral-100 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
          >
            Open family
          </Link>
        )}
        <a
          href="#section-notes"
          className="inline-flex h-8 items-center rounded-md bg-neutral-100 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
        >
          Raise note
        </a>
      </div>

      {/* Search */}
      <ContactSearchBar contactId={contact.id} />

      {/* KPI tiles */}
      <ChannelTiles summary={summary} />

      {/* Pinned notes / contact-level note */}
      {contact.notes && (
        <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-neutral-800">
          <span className="text-xs font-semibold uppercase text-amber-800">Pinned</span>
          <p className="mt-1">{contact.notes}</p>
        </div>
      )}

      {/* Sections */}
      <section className="mt-8 space-y-3">
        <SectionHeader id="section-email" title="Email" />
        <EmailSection threads={emailThreads.items} />
      </section>

      <section className="mt-8 space-y-3">
        <SectionHeader id="section-calls" title="Calls" />
        <CallsSection calls={calls.items} />
      </section>

      <section className="mt-8 space-y-3">
        <SectionHeader id="section-slack" title="Slack mentions" />
        <SlackSection mentions={slackMentions.items} />
      </section>

      <section className="mt-8 space-y-3">
        <SectionHeader id="section-trengo" title="Trengo conversations" />
        <TrengoSection conversations={trengo.items} />
      </section>

      <section className="mt-8 space-y-3">
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200 pb-1">
          <h2
            id="section-tasks"
            className="scroll-mt-20 text-lg font-semibold text-neutral-900"
          >
            Tasks
          </h2>
          <NewTaskDialog contactId={contact.id} contactName={contact.displayName} />
        </div>
        <TasksSection open={tasks.open} closed={tasks.closed} />
      </section>

      <section className="mt-8 space-y-3">
        <SectionHeader id="section-notes" title="Notes" />
        <AddNote contactId={contact.id} />
        {notes.items.length > 0 ? (
          <ol className="space-y-2">
            {notes.items.map((n) => (
              <li
                key={n.id}
                className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm"
              >
                <div className="text-xs text-neutral-500">
                  <time dateTime={new Date(n.occurredAt).toISOString()}>
                    {new Intl.DateTimeFormat('en-GB', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(n.occurredAt))}
                  </time>
                </div>
                <p className="mt-1 text-neutral-900">{n.body ?? n.summary ?? '—'}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-neutral-600">
            No notes yet — add the first note above.
          </p>
        )}
      </section>

      {/* Aggregate timeline (fallback view) */}
      <section className="mt-8 space-y-3">
        <SectionHeader id="section-timeline" title="Activity timeline" />
        <Timeline
          initialItems={timeline.items}
          initialNextCursor={timeline.nextCursor}
          contactId={contact.id}
        />
      </section>
    </div>
  )
}
