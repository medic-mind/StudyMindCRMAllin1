// Comprehensive customer view (ADR 0017). RSC loads every channel via the
// contact.channels.* tRPC procedures; client islands handle interactive
// Reply / Expand / Search controls. Each channel renders its own shape — not
// a generic Interaction list — and every section degrades gracefully when
// empty.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { PaymentsPanel } from '@/components/finance/PaymentsPanel'
import { ContactDirectDebitPanel } from '@/components/finance/gocardless/ContactDirectDebitPanel'
import { SendPaymentLinkButton } from '@/components/finance/SendPaymentLinkButton'
import { InvoicesPanel } from '@/components/invoices/InvoicesPanel'
import { ComposeEmailButton } from '@/components/mail/compose-email'
import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  ActivityIcon,
  AlertTriangleIcon,
  CalendarIcon,
  CoinsIcon,
  FileTextIcon,
  ListTodoIcon,
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
  InboxIcon,
  SmartphoneIcon,
  UsersIcon,
} from '@/components/ui/icon'

import { NewTaskDialog } from '../../tasks/NewTaskDialog'

import { AddNote } from './AddNote'
import { CallButton } from './CallButton'
import { EditContactButton } from './EditContactButton'
import { Timeline } from './Timeline'
import { CallsSection } from './sections/CallsSection'
import { CallSummariesFeed } from './sections/CallSummariesFeed'
import { CallSummarySection } from './sections/CallSummarySection'
import { BookingSection } from './sections/BookingSection'
import { ChannelTiles } from './sections/ChannelTiles'
import { ComplaintsSection } from './sections/ComplaintsSection'
import { ContactSearchBar } from './sections/ContactSearchBar'
import { DocumentsSection } from './sections/DocumentsSection'
import { EnquiriesSection } from './sections/EnquiriesSection'
import { EmailSection } from './sections/EmailSection'
import { ForwardingSection } from './sections/ForwardingSection'
import { LinkedContactsSection } from './sections/LinkedContactsSection'
import { MailchimpPushButton } from './sections/MailchimpPushButton'
import { SlackSection } from './sections/SlackSection'
import { TasksSection } from './sections/TasksSection'
import { TrengoSection } from './sections/TrengoSection'

const KIND_TONE: Record<string, BadgeTone> = {
  parent: 'info',
  student: 'accent',
  tutor: 'success',
  other: 'neutral',
}

function formatKind(kind: string): string {
  if (kind === 'la_caseworker') return 'LA caseworker'
  const s = kind.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatDate(d: Date | string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(d))
}

const ACTION_LINK_CLS =
  'inline-flex h-9 items-center rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 shadow-card transition-colors hover:border-neutral-300 hover:bg-neutral-50'

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
    <Card className="overflow-hidden transition-shadow hover:shadow-card-hover">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-100 bg-gradient-to-b from-neutral-50/60 to-white px-4 py-3">
        <h2
          id={id}
          className="flex scroll-mt-24 items-center gap-2.5 text-sm font-semibold text-neutral-900"
        >
          <span
            aria-hidden="true"
            className="flex h-6 w-6 items-center justify-center rounded-md bg-primary-50 text-primary-700"
          >
            {icon}
          </span>
          {title}
        </h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </Card>
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

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const caller = await createServerCaller()
  const me = await getCurrentUser()
  // Money actions (send a DD setup link) mirror the gocardless router's
  // finance gate; everyone else sees the panel read-only (§20.1).
  const canManageDirectDebit = ['ceo', 'senior_manager', 'manager'].includes(me?.role ?? '')

  let contact
  try {
    contact = await caller.contact.get({ id })
  } catch {
    notFound()
  }
  if (!contact) notFound()

  // One round-trip for the KPI tiles, then per-channel lists in parallel.
  const [
    summary,
    emailThreads,
    calls,
    slackMentions,
    callSummaryFeed,
    trengo,
    trengoTags,
    tasks,
    notes,
    timeline,
    bookingSummary,
    bookingLessons,
  ] = await Promise.all([
    caller.contact.channels.summary({ contactId: id }),
    caller.contact.channels.emailThreads({ contactId: id, limit: 25 }),
    caller.contact.channels.calls({ contactId: id, limit: 25 }),
    caller.contact.channels.slackMentions({ contactId: id, limit: 25 }),
    caller.contact.channels.callSummaries({ contactId: id, limit: 25 }),
    caller.contact.channels.trengoConversations({ contactId: id, limit: 25 }),
    caller.contact.channels.trengoTags({ contactId: id }),
    caller.contact.channels.tasks({ contactId: id }),
    caller.contact.channels.notes({ contactId: id, limit: 25 }),
    caller.interaction.list({ contactId: id, limit: 25 }),
    caller.contact.booking.summary({ contactId: id }),
    caller.contact.booking.lessons({ contactId: id, limit: 20 }),
  ])

  const kindTone = KIND_TONE[contact.kind] ?? 'neutral'

  // Light "jump to section" nav — keeps the full page, just makes it navigable
  // (every section still renders below). Anchors land below the sticky bar via
  // the SectionCard heading's scroll-mt.
  const sectionNav: Array<[string, string]> = [
    ['section-links', 'Linked'],
    ['section-booking', 'Booking'],
    ['section-complaints', 'Complaints'],
    ['section-enquiries', 'Enquiries'],
    ['section-email', 'Email'],
    ['section-calls', 'Calls'],
    ['section-call-summaries', 'Call summaries'],
    ['section-call-summary', 'Record summary'],
    ['section-forward', 'Forward'],
    ['section-slack', 'Slack'],
    ['section-trengo', 'Trengo'],
    ['section-payments', 'Payments'],
    ['section-invoices', 'Invoices'],
    ['section-tasks', 'Tasks'],
    ['section-notes', 'Notes'],
    ['section-documents', 'Documents'],
    ['section-timeline', 'Timeline'],
  ]

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Hero header */}
      <header className="relative overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-card">
        {/* Brand wash background — a whisper of the primary blue in the top
            corner (matches the dashboard hero), kept low-opacity so it reads
            calm, not washed in colour. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 100% at 0% 0%, rgb(37 99 235 / 0.06), transparent 55%), linear-gradient(180deg, rgb(239 246 255 / 0.5) 0%, transparent 60%)',
          }}
        />
        <div className="relative flex flex-col gap-5 p-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-5">
            <div className="rounded-full bg-white p-1 shadow-sm ring-1 ring-primary-100">
              <Avatar name={contact.displayName} size={64} className="ring-2 ring-primary-50" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-3xl font-semibold leading-tight tracking-tight text-neutral-900">
                  {contact.displayName}
                </h1>
                {contact.companies.map((c) => (
                  <span
                    key={c.id}
                    className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white"
                    style={{ backgroundColor: c.color ?? '#475569' }}
                  >
                    {c.name}
                  </span>
                ))}
                <Badge tone={kindTone} dot>
                  {formatKind(contact.kind)}
                </Badge>
                {contact.isMinor && (
                  <Badge tone="warn" dot>
                    Minor
                  </Badge>
                )}
                {contact.isRestricted && (
                  <Badge tone="danger" dot>
                    Restricted
                  </Badge>
                )}
              </div>
              {contact.jobTitle && (
                <p className="mt-1 text-sm font-medium text-neutral-600">{contact.jobTitle}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-neutral-600">
                {contact.email && (
                  <EmailLink
                    email={contact.email}
                    className="inline-flex items-center gap-1.5 transition-colors hover:text-primary-700"
                  />
                )}
                {contact.phoneE164 && <PhoneLink phone={contact.phoneE164} />}
                {contact.family && (
                  <Link
                    href={`/contacts/families/${contact.family.id}`}
                    className="inline-flex items-center gap-1.5 font-medium text-primary-700 hover:underline"
                  >
                    <UsersIcon size={14} />
                    {contact.family.name ?? 'Family'}
                  </Link>
                )}
                <span className="inline-flex items-center gap-1.5 text-neutral-500">
                  <ActivityIcon size={14} className="text-neutral-400" />
                  Added {formatDate(contact.createdAt)}
                </span>
              </div>
              {contact.subjects.length > 0 || contact.enquiryTypes.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {contact.subjects.map((s) => (
                    <span
                      key={s.id}
                      className="inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-medium text-primary-800"
                      title="Subject"
                    >
                      {s.name}
                    </span>
                  ))}
                  {contact.enquiryTypes
                    .filter((t) => !contact.subjects.some((s) => s.name === t))
                    .map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-100"
                        title="What they enquired about (latest first)"
                      >
                        {t}
                      </span>
                    ))}
                </div>
              ) : null}
            </div>
          </div>

          {/* Action toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <CallButton
              contactId={contact.id}
              phoneE164={contact.phoneE164}
              displayName={contact.displayName}
            />
            {contact.email && (
              <ComposeEmailButton to={contact.email} size="sm" variant="secondary" />
            )}
            <EditContactButton contactId={contact.id} />
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
            <a href="#section-forward" className={ACTION_LINK_CLS}>
              Forward to…
            </a>
          </div>
        </div>
      </header>

      {/* KPI tiles */}
      <ChannelTiles summary={summary} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* Main column */}
        <div className="min-w-0 space-y-5">
          {/* Quick jump nav — full page stays; this just makes it navigable. */}
          <nav
            aria-label="Jump to section"
            className="sticky top-0 z-20 -mx-1 flex flex-wrap gap-1 rounded-lg border border-neutral-200 bg-white/90 px-2 py-1.5 shadow-card backdrop-blur supports-[backdrop-filter]:bg-white/75"
          >
            {sectionNav.map(([anchor, label]) => (
              <a
                key={anchor}
                href={`#${anchor}`}
                className="rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-primary-50 hover:text-primary-700"
              >
                {label}
              </a>
            ))}
          </nav>
          <ContactSearchBar contactId={contact.id} />

          <SectionCard id="section-links" title="Linked contacts" icon={<UsersIcon size={16} />}>
            <LinkedContactsSection contactId={contact.id} />
          </SectionCard>

          <SectionCard
            id="section-booking"
            title="Booking & hours"
            icon={<CalendarIcon size={16} />}
          >
            <BookingSection summary={bookingSummary} lessons={bookingLessons} />
          </SectionCard>

          <SectionCard
            id="section-complaints"
            title="Complaints"
            icon={<AlertTriangleIcon size={16} />}
          >
            <ComplaintsSection contactId={contact.id} />
          </SectionCard>

          <SectionCard id="section-enquiries" title="Enquiries" icon={<InboxIcon size={16} />}>
            <EnquiriesSection contactId={contact.id} />
          </SectionCard>

          <SectionCard id="section-email" title="Email" icon={<MailIcon size={16} />}>
            <EmailSection threads={emailThreads.items} />
          </SectionCard>

          <SectionCard id="section-calls" title="Calls" icon={<PhoneIcon size={16} />}>
            <CallsSection calls={calls.items} />
          </SectionCard>

          <SectionCard
            id="section-call-summaries"
            title="Call summaries"
            icon={<MessageSquareIcon size={16} />}
          >
            <CallSummariesFeed summaries={callSummaryFeed.items} />
          </SectionCard>

          <SectionCard
            id="section-call-summary"
            title="Record call summary"
            icon={<PhoneIcon size={16} />}
          >
            <CallSummarySection contactId={contact.id} contactDisplayName={contact.displayName} />
          </SectionCard>

          <SectionCard id="section-forward" title="Forward to team" icon={<MailIcon size={16} />}>
            <ForwardingSection contactId={contact.id} />
          </SectionCard>

          <SectionCard
            id="section-slack"
            title="Slack mentions"
            icon={<MessageSquareIcon size={16} />}
          >
            <SlackSection mentions={slackMentions.items} />
          </SectionCard>

          <SectionCard
            id="section-trengo"
            title="Trengo conversations"
            icon={<SmartphoneIcon size={16} />}
          >
            {trengoTags.length > 0 ? (
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <span className="text-xs uppercase tracking-wide text-neutral-500">Tags</span>
                {trengoTags.map((t) => (
                  <span
                    key={t.name}
                    className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-700"
                    title={`${t.conversationCount} conversation${t.conversationCount === 1 ? '' : 's'}`}
                  >
                    {t.name}
                    {t.conversationCount > 1 ? (
                      <span className="font-mono text-[10px] text-neutral-500">
                        ×{t.conversationCount}
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : null}
            <TrengoSection contactId={contact.id} conversations={trengo.items} />
          </SectionCard>

          <SectionCard id="section-payments" title="Payments" icon={<CoinsIcon size={16} />}>
            <PaymentsPanel target={{ contactId: contact.id }} />
          </SectionCard>

          <SectionCard
            id="section-direct-debit"
            title="Direct Debit"
            icon={<CoinsIcon size={16} />}
          >
            <ContactDirectDebitPanel contactId={contact.id} canManage={canManageDirectDebit} />
          </SectionCard>

          <SectionCard
            id="section-invoices"
            title="Uploaded invoices"
            icon={<FileTextIcon size={16} />}
          >
            <InvoicesPanel target={{ kind: 'contact', contactId: contact.id }} />
          </SectionCard>

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

          <SectionCard id="section-documents" title="Documents" icon={<FileTextIcon size={16} />}>
            <DocumentsSection contactId={contact.id} />
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
            <div className="rounded-xl border border-secondary-200 bg-secondary-50 p-4 text-sm text-neutral-800 shadow-card">
              <span className="text-xs font-semibold uppercase tracking-wide text-secondary-800">
                Pinned note
              </span>
              <p className="mt-1.5 whitespace-pre-line">{contact.notes}</p>
            </div>
          )}

          <Card className="overflow-hidden">
            {/* Identity group */}
            <div className="border-b border-neutral-100 p-4">
              <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
                Identity
              </h3>
              <dl className="space-y-3">
                <DetailRow label="Type">
                  <Badge tone={kindTone} dot>
                    {formatKind(contact.kind)}
                  </Badge>
                </DetailRow>
                <DetailRow label="Family">
                  {contact.family ? (
                    <Link
                      href={`/contacts/families/${contact.family.id}`}
                      className="font-medium text-primary-700 hover:underline"
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
                {contact.dateOfBirth && (
                  <DetailRow label="DOB">{formatDate(contact.dateOfBirth)}</DetailRow>
                )}
                {contact.pronouns && <DetailRow label="Pronouns">{contact.pronouns}</DetailRow>}
                {contact.preferredContactMethod && (
                  <DetailRow label="Preferred">
                    <span className="capitalize">
                      {contact.preferredContactMethod === 'whatsapp'
                        ? 'WhatsApp'
                        : contact.preferredContactMethod}
                    </span>
                  </DetailRow>
                )}
                {contact.timezone && <DetailRow label="Time zone">{contact.timezone}</DetailRow>}
              </dl>
            </div>

            {/* Education group (students) */}
            {(contact.schoolName || contact.yearGroup || contact.sendStatus) && (
              <div className="border-b border-neutral-100 p-4">
                <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
                  Education
                </h3>
                <dl className="space-y-3">
                  {contact.schoolName && (
                    <DetailRow label="School">
                      <span className="text-right">
                        {contact.schoolName}
                        {contact.yearGroup ? (
                          <span className="block text-xs text-neutral-500">
                            {contact.yearGroup}
                          </span>
                        ) : null}
                      </span>
                    </DetailRow>
                  )}
                  {!contact.schoolName && contact.yearGroup && (
                    <DetailRow label="Year group">{contact.yearGroup}</DetailRow>
                  )}
                  {contact.sendStatus && (
                    <DetailRow label="SEND">
                      <Badge
                        tone={
                          contact.sendStatus === 'ehcp_in_place'
                            ? 'info'
                            : contact.sendStatus === 'ehcp_in_progress' ||
                                contact.sendStatus === 'send_support'
                              ? 'warn'
                              : 'neutral'
                        }
                        dot
                      >
                        {contact.sendStatus.replace(/_/g, ' ')}
                      </Badge>
                    </DetailRow>
                  )}
                  {contact.examTarget && (
                    <DetailRow label="Exam target">{contact.examTarget}</DetailRow>
                  )}
                </dl>
              </div>
            )}

            {/* Address group */}
            {(contact.addressLine1 || contact.city || contact.postcode) && (
              <div className="border-b border-neutral-100 p-4">
                <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
                  Address
                </h3>
                <p className="text-sm text-neutral-700">
                  {[
                    contact.addressLine1,
                    contact.addressLine2,
                    contact.city,
                    contact.postcode,
                    contact.country,
                  ]
                    .filter(Boolean)
                    .map((part, i) => (
                      <span key={i} className="block">
                        {part}
                      </span>
                    ))}
                </p>
              </div>
            )}

            {/* Marketing group */}
            <div className="border-b border-neutral-100 p-4">
              <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
                Marketing
              </h3>
              <dl className="space-y-3">
                {contact.referralSource && (
                  <DetailRow label="Source">{contact.referralSource}</DetailRow>
                )}
                {(contact.mailchimpEmail || contact.email) && (
                  <DetailRow label="Mailchimp">
                    <div className="space-y-1.5">
                      <div className="break-all text-xs text-neutral-600">
                        {contact.mailchimpEmail ?? contact.email}
                      </div>
                      <MailchimpPushButton contactId={contact.id} />
                    </div>
                  </DetailRow>
                )}
                {!contact.mailchimpEmail && !contact.email && (
                  <p className="text-xs text-neutral-400">
                    Add an email to push to a Mailchimp audience.
                  </p>
                )}
              </dl>
            </div>

            {/* Reference group */}
            <div className="p-4">
              <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
                Reference
              </h3>
              <dl className="space-y-3">
                <DetailRow label="Added">{formatDate(contact.createdAt)}</DetailRow>
                <DetailRow label="ID">
                  <span className="break-all font-mono text-xs text-neutral-500">{contact.id}</span>
                </DetailRow>
              </dl>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  )
}
