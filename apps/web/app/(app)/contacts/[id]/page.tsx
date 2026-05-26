// Comprehensive customer view (ADR 0017). RSC loads every channel via the
// contact.channels.* tRPC procedures; client islands handle interactive
// Reply / Expand / Search controls. Each channel renders its own shape — not
// a generic Interaction list — and every section degrades gracefully when
// empty.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { createServerCaller } from '@/lib/trpc/server'

import { PaymentsPanel } from '@/components/finance/PaymentsPanel'
import { SendPaymentLinkButton } from '@/components/finance/SendPaymentLinkButton'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import {
  ActivityIcon,
  CoinsIcon,
  FileTextIcon,
  ListTodoIcon,
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
  SmartphoneIcon,
  UsersIcon,
} from '@/components/ui/icon'

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

const KIND_TONE: Record<string, BadgeTone> = {
  parent: 'info',
  student: 'accent',
  tutor: 'success',
  la_caseworker: 'warn',
  other: 'neutral',
}

function formatKind(kind: string): string {
  return kind.replace(/_/g, ' ')
}

function formatDate(d: Date | string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(d))
}

const ACTION_LINK_CLS =
  'inline-flex h-9 items-center rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 shadow-sm transition-colors hover:bg-neutral-50'

function SectionCard({
  id,
  title,
  icon,
  action,
  children,
}: {
  id: string
  title: string
  icon: ReactNode
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50/70 px-4 py-2.5">
        <h2
          id={id}
          className="flex scroll-mt-24 items-center gap-2 text-sm font-semibold text-neutral-900"
        >
          <span aria-hidden="true" className="text-neutral-400">
            {icon}
          </span>
          {title}
        </h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </dt>
      <dd className="min-w-0 text-right text-sm text-neutral-800">{children}</dd>
    </div>
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

  const kindTone = KIND_TONE[contact.kind] ?? 'neutral'

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Hero header */}
      <header className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <Avatar name={contact.displayName} size={56} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-neutral-900">
                  {contact.displayName}
                </h1>
                <Badge tone={kindTone}>{formatKind(contact.kind)}</Badge>
                {contact.isMinor && <Badge tone="warn">Minor</Badge>}
                {contact.isRestricted && <Badge tone="danger">Restricted</Badge>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-neutral-600">
                {contact.email && (
                  <a
                    href={`mailto:${contact.email}`}
                    className="inline-flex items-center gap-1.5 hover:text-primary-700"
                  >
                    <MailIcon size={14} className="text-neutral-400" />
                    {contact.email}
                  </a>
                )}
                {contact.phoneE164 && (
                  <span className="inline-flex items-center gap-1.5">
                    <PhoneIcon size={14} className="text-neutral-400" />
                    <span className="font-mono">{contact.phoneE164}</span>
                  </span>
                )}
                {contact.family && (
                  <Link
                    href={`/contacts/families/${contact.family.id}`}
                    className="inline-flex items-center gap-1.5 text-primary-700 hover:underline"
                  >
                    <UsersIcon size={14} />
                    {contact.family.name ?? 'Family'}
                  </Link>
                )}
              </div>
            </div>
          </div>

          {/* Action toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            {contact.family && (
              <SendPaymentLinkButton familyId={contact.family.id} contactId={contact.id} />
            )}
            <Link href={`/finance/refunds/new?contactId=${contact.id}`} className={ACTION_LINK_CLS}>
              Issue refund
            </Link>
            {contact.family && (
              <Link href={`/contacts/families/${contact.family.id}`} className={ACTION_LINK_CLS}>
                Open family
              </Link>
            )}
            <a href="#section-notes" className={ACTION_LINK_CLS}>
              Add note
            </a>
          </div>
        </div>
      </header>

      {/* KPI tiles */}
      <ChannelTiles summary={summary} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* Main column */}
        <div className="min-w-0 space-y-5">
          <ContactSearchBar contactId={contact.id} />

          <SectionCard id="section-email" title="Email" icon={<MailIcon size={16} />}>
            <EmailSection threads={emailThreads.items} />
          </SectionCard>

          <SectionCard id="section-calls" title="Calls" icon={<PhoneIcon size={16} />}>
            <CallsSection calls={calls.items} />
          </SectionCard>

          <SectionCard id="section-slack" title="Slack mentions" icon={<MessageSquareIcon size={16} />}>
            <SlackSection mentions={slackMentions.items} />
          </SectionCard>

          <SectionCard
            id="section-trengo"
            title="Trengo conversations"
            icon={<SmartphoneIcon size={16} />}
          >
            <TrengoSection conversations={trengo.items} />
          </SectionCard>

          {contact.family && (
            <SectionCard id="section-payments" title="Payments" icon={<CoinsIcon size={16} />}>
              <PaymentsPanel target={{ contactId: contact.id }} />
            </SectionCard>
          )}

          <SectionCard
            id="section-tasks"
            title="Tasks"
            icon={<ListTodoIcon size={16} />}
            action={<NewTaskDialog contactId={contact.id} contactName={contact.displayName} />}
          >
            <TasksSection open={tasks.open} closed={tasks.closed} />
          </SectionCard>

          <SectionCard id="section-notes" title="Notes" icon={<FileTextIcon size={16} />}>
            <div className="space-y-3">
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
                <p className="text-sm text-neutral-600">No notes yet — add the first note above.</p>
              )}
            </div>
          </SectionCard>

          <SectionCard
            id="section-timeline"
            title="Activity timeline"
            icon={<ActivityIcon size={16} />}
          >
            <Timeline
              initialItems={timeline.items}
              initialNextCursor={timeline.nextCursor}
              contactId={contact.id}
            />
          </SectionCard>
        </div>

        {/* Sticky detail rail */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          {contact.notes && (
            <div className="rounded-xl border border-secondary-200 bg-secondary-50 p-4 text-sm text-neutral-800 shadow-sm">
              <span className="text-xs font-semibold uppercase tracking-wide text-secondary-800">
                Pinned note
              </span>
              <p className="mt-1.5 whitespace-pre-line">{contact.notes}</p>
            </div>
          )}

          <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Details
            </h2>
            <dl className="mt-3 space-y-3">
              <DetailRow label="Type">
                <Badge tone={kindTone}>{formatKind(contact.kind)}</Badge>
              </DetailRow>
              <DetailRow label="Family">
                {contact.family ? (
                  <Link
                    href={`/contacts/families/${contact.family.id}`}
                    className="text-primary-700 hover:underline"
                  >
                    {contact.family.name ?? 'Family'}
                  </Link>
                ) : (
                  <span className="text-neutral-400">Unassigned</span>
                )}
              </DetailRow>
              {contact.isMinor && (
                <DetailRow label="Minor">
                  <span className="text-amber-700">Yes — reads audited</span>
                </DetailRow>
              )}
              {contact.isRestricted && (
                <DetailRow label="Access">
                  <span className="text-red-700">Restricted</span>
                </DetailRow>
              )}
              <DetailRow label="Added">{formatDate(contact.createdAt)}</DetailRow>
              <DetailRow label="Reference">
                <span className="break-all font-mono text-xs text-neutral-500">{contact.id}</span>
              </DetailRow>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  )
}
