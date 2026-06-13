'use client'

// Right pane of the cockpit: contact + ticket context and the per-conversation
// actions (assign, labels, snooze/mark-read, create task) — the same audited
// islands the old detail page used, so each still syncs to Trengo / Gmail. It
// reads the same cached `inbox.conversations.get` query the thread pane uses, so
// there is no extra round-trip. ADR 0020. CLAUDE.md §11, §20, §26.

import Link from 'next/link'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { XIcon } from '@/components/ui/icon'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

import { AssignControl } from './AssignControl'
import { ChannelIcon, channelLabelFor, type CockpitMe } from './cockpit-shared'
import { ConversationTaskButton } from './ConversationTaskButton'
import { MailThreadActions } from './MailThreadActions'
import { TrengoThreadActions } from './TrengoThreadActions'

export function ContextPane({
  conversationId,
  me,
  onClose,
  onSelect,
}: {
  conversationId: string
  me: CockpitMe
  /** Close the pane — used by the backdrop + the X on the overlay (small
   *  screens). On xl the pane is a static column and onClose is unused. */
  onClose?: () => void
  /** Open another of the contact's conversations (Trengo "previous
   *  conversations" / linked tickets). */
  onSelect?: (id: string) => void
}) {
  const convo = trpc.inbox.conversations.get.useQuery({ conversationId })
  const head = convo.data?.head
  const utils = trpc.useUtils()
  const context = trpc.inbox.conversations.context.useQuery(
    { conversationId },
    { staleTime: 30_000, retry: false },
  )
  const setSpam = trpc.inbox.conversations.setSpam.useMutation({
    onSuccess: () => {
      void utils.inbox.conversations.get.invalidate({ conversationId })
      void utils.inbox.conversations.list.invalidate()
      void utils.inbox.conversations.counts.invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not update spam state'),
  })

  // The pane is a static right column on xl, and a slide-over drawer (with a
  // dimmed backdrop) below xl — so Assign / Snooze / Labels / Mark-read /
  // Task are reachable on laptops + tablets, not hidden off-screen. The
  // wrapper classes are identical whether or not we have a head yet so the
  // layout never jumps.
  const aside = (className: string, children: React.ReactNode) => (
    <>
      {/* Backdrop — only on small screens (the drawer overlays the thread). */}
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="fixed inset-0 z-30 bg-neutral-900/30 xl:hidden"
      />
      <aside className={className}>{children}</aside>
    </>
  )

  const wrapperClass =
    'fixed inset-y-0 right-0 z-40 flex w-80 max-w-[85vw] shrink-0 flex-col overflow-y-auto border-l border-neutral-200 bg-white shadow-2xl xl:static xl:z-auto xl:max-w-none xl:shadow-none'

  if (!head) {
    return aside(
      wrapperClass,
      <div className="p-4 text-sm text-neutral-400">Loading…</div>,
    )
  }
  const now = new Date()
  const isEmail = head.provider === 'email'
  const defaultTitle = `Follow up: ${head.subject ?? head.contactName ?? 'conversation'}`.slice(
    0,
    280,
  )

  return aside(
    wrapperClass,
    <>
      {/* Mobile close affordance (the static xl column has the thread toggle). */}
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 xl:hidden">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Details
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100"
        >
          <XIcon size={16} />
        </button>
      </div>
      {/* Contact header */}
      <div className="border-b border-neutral-200 p-4">
        <div className="flex items-center gap-3">
          <Avatar name={head.contactName ?? 'Unmatched'} size={40} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-neutral-900">
              {head.contactName ?? 'Unmatched contact'}
            </p>
            <p className="flex items-center gap-1 text-xs text-neutral-500">
              <ChannelIcon channel={head.channel} size={12} />
              {channelLabelFor(head.channel)}
            </p>
          </div>
        </div>
        {head.contactId ? (
          <Link
            href={`/contacts/${head.contactId}`}
            className="mt-3 block rounded-md border border-neutral-200 px-3 py-1.5 text-center text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Open full contact
          </Link>
        ) : (
          <p className="mt-3 rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
            Not matched to a contact yet.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-3 p-3">
        {isEmail ? (
          <MailThreadActions
            conversationId={head.id}
            unread={head.unreadCount > 0}
            archived={head.status === 'archived'}
          />
        ) : (
          <>
            {head.contactId && head.trengoTicketId !== null ? (
              <AssignControl
                conversationId={head.id}
                contactId={head.contactId}
                ticketId={head.trengoTicketId}
                trengoAssigneeId={head.trengoAssigneeId}
              />
            ) : null}
            <TrengoThreadActions
              conversationId={head.id}
              contactId={head.contactId}
              ticketId={head.trengoTicketId}
              tags={head.tags}
              unread={head.unreadCount > 0}
              status={head.status}
            />
          </>
        )}

        <div className="rounded-lg border border-neutral-200 bg-white p-3 text-sm shadow-sm">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Task
          </h2>
          <ConversationTaskButton
            contactId={head.contactId}
            meId={me.id}
            defaultTitle={defaultTitle}
          />
        </div>

        {/* Spam box (Trengo parity) — CRM-side; restores to the open inbox. */}
        {!isEmail ? (
          head.status === 'spam' ? (
            <button
              type="button"
              disabled={setSpam.isPending}
              onClick={() => setSpam.mutate({ conversationId: head.id, spam: false })}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              Not spam — restore to inbox
            </button>
          ) : (
            <button
              type="button"
              disabled={setSpam.isPending}
              onClick={() => setSpam.mutate({ conversationId: head.id, spam: true })}
              className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-500 hover:border-danger-200 hover:bg-danger-50 hover:text-danger-700 disabled:opacity-50"
            >
              Mark as spam
            </button>
          )
        ) : null}
      </div>

      {/* Contact "custom fields" (Trengo right-pane parity). */}
      {context.data?.contact ? (
        <div className="border-t border-neutral-200 p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Details
          </h2>
          <dl className="space-y-1.5 text-xs">
            {context.data.contact.email ? (
              <MetaRow label="Email" value={context.data.contact.email} />
            ) : null}
            {context.data.contact.phone ? (
              <MetaRow label="Phone" value={context.data.contact.phone} mono />
            ) : null}
            {context.data.contact.country ? (
              <MetaRow label="Country" value={context.data.contact.country} />
            ) : null}
            {context.data.contact.referralSource ? (
              <MetaRow label="Source" value={context.data.contact.referralSource} />
            ) : null}
            {context.data.contact.bookingStatus ? (
              <MetaRow label="Booking" value={context.data.contact.bookingStatus} />
            ) : null}
          </dl>
        </div>
      ) : null}

      {/* Previous conversations (Trengo "linked / previous conversations"). */}
      {(context.data?.otherConversations.length ?? 0) > 0 ? (
        <div className="border-t border-neutral-200 p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Previous conversations
          </h2>
          <ul className="space-y-1">
            {context.data!.otherConversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect?.(c.id)}
                  disabled={!onSelect}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-50 disabled:cursor-default"
                >
                  <ChannelIcon channel={c.channel} size={13} />
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-700">
                    {c.subject || c.lastMessagePreview || channelLabelFor(c.channel)}
                  </span>
                  {c.status === 'closed' ? (
                    <span className="text-[10px] text-neutral-400">Closed</span>
                  ) : null}
                  <time className="shrink-0 text-[10px] tabular-nums text-neutral-400">
                    {formatRelativeTime(new Date(c.lastMessageAt), now)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Meta */}
      <dl className="mt-auto space-y-1.5 border-t border-neutral-200 p-4 text-xs">
        {head.trengoTicketId !== null ? (
          <MetaRow label="Ticket" value={`#${head.trengoTicketId}`} mono />
        ) : null}
        <MetaRow label="Status" value={head.status} />
        {head.assigneeName ? (
          <MetaRow label="Assigned to" value={head.assigneeName} />
        ) : null}
        {head.lastMessageAt ? (
          <MetaRow
            label="Last message"
            value={formatRelativeTime(new Date(head.lastMessageAt), now)}
          />
        ) : null}
        {head.tags.length > 0 ? <MetaRow label="Labels" value={head.tags.join(', ')} /> : null}
      </dl>
    </>,
  )
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-neutral-400">{label}</dt>
      <dd className={`truncate text-neutral-700 ${mono ? 'font-mono tabular-nums' : ''}`}>
        {value}
      </dd>
    </div>
  )
}
