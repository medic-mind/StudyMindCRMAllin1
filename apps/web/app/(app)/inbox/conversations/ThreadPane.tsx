'use client'

// Centre pane of the cockpit: the open conversation's message thread plus the
// composer. ADR 0020. The composer is the existing audited island
// (ConversationReply for Trengo, EmailReply for Gmail) so replies still send on
// the right channel and sync back. A "Comment" tab swaps the reply box for the
// internal-notes island (staff-only). CLAUDE.md §11, §20, §26.

import Link from 'next/link'
import { Fragment, useState } from 'react'

import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { ChevronLeftIcon, UserCircleIcon } from '@/components/ui/icon'
import { displayMessageBody } from '@/lib/format/html-text'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

import { ChannelIcon, channelLabelFor } from './cockpit-shared'
import { ConversationNotes } from './ConversationNotes'
import { ConversationReply } from './ConversationReply'
import { EmailReply } from './EmailReply'

export function ThreadPane({
  conversationId,
  showContext,
  onToggleContext,
  onClose,
}: {
  conversationId: string
  showContext: boolean
  onToggleContext: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'reply' | 'comment'>('reply')

  // Poll the open thread lightly so an inbound message that lands while you are
  // reading appears promptly. The list itself is kept live by the SSE stream.
  const convo = trpc.inbox.conversations.get.useQuery(
    { conversationId },
    { refetchInterval: 15_000, refetchOnWindowFocus: true },
  )

  if (convo.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">
        Loading conversation…
      </div>
    )
  }
  const data = convo.data
  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">
        Conversation not found.
      </div>
    )
  }

  const { head, messages } = data
  const now = new Date()
  const isEmail = head.provider === 'email'
  const replyWindowOpen =
    head.replyDeadlineAt && new Date(head.replyDeadlineAt).getTime() > now.getTime()
  const latestInteractionId = messages[messages.length - 1]?.id ?? null
  const canReplyTrengo = !!head.contactId && head.trengoTicketId !== null

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Thread header */}
      <header className="flex items-center gap-2 border-b border-neutral-200 bg-white px-3 py-2.5">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to list"
          className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 lg:hidden"
        >
          <ChevronLeftIcon size={18} />
        </button>
        <Avatar name={head.contactName ?? 'Unmatched'} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-neutral-900">
              {head.contactName ?? 'Unmatched conversation'}
            </h1>
            <ChannelIcon channel={head.channel} size={13} />
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
            <span>{channelLabelFor(head.channel)}</span>
            {head.trengoTicketId !== null ? (
              <span className="font-mono">· #{head.trengoTicketId}</span>
            ) : null}
            <span>· {head.status}</span>
          </div>
        </div>
        {head.status === 'closed' ? <Badge tone="neutral">Closed</Badge> : null}
        {head.status === 'snoozed' ? <Badge tone="warn">Snoozed</Badge> : null}
        {head.channel === 'whatsapp' && head.replyDeadlineAt ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              replyWindowOpen ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
            }`}
          >
            {replyWindowOpen ? '24h window open' : '24h window closed'}
          </span>
        ) : null}
        {head.contactId ? (
          <Link
            href={`/contacts/${head.contactId}`}
            className="hidden rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 sm:block"
          >
            Open contact
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onToggleContext}
          aria-label={showContext ? 'Hide details' : 'Show details'}
          aria-pressed={showContext}
          className={`rounded-md p-1.5 ${
            showContext
              ? 'bg-neutral-100 text-neutral-700'
              : 'text-neutral-400 hover:bg-neutral-100'
          }`}
        >
          <UserCircleIcon size={16} />
        </button>
      </header>

      {/* Labels + subject strip — the same chips Trengo shows on the ticket. */}
      {head.tags.length > 0 || head.subject ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 bg-white px-4 py-1.5">
          {head.subject ? (
            <span className="truncate text-xs font-medium text-neutral-700">
              {head.subject}
            </span>
          ) : null}
          {head.tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 text-[10px] font-medium text-primary-800"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {/* Messages — customer on the left, us on the right, named senders and
          day separators, the way the Trengo thread reads. */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-center text-sm text-neutral-400">
            No messages on this conversation yet.
          </p>
        ) : (
          messages.map((m, i) => {
            const outbound = m.direction === 'outbound'
            const prev = messages[i - 1]
            const newDay =
              !prev || prev.occurredAt.toDateString() !== m.occurredAt.toDateString()
            const sender = outbound
              ? (m.senderName ?? 'You')
              : m.direction === 'inbound'
                ? (m.senderName ?? head.contactName ?? 'Customer')
                : 'System'
            return (
              <Fragment key={m.id}>
                {newDay ? <DaySeparator date={m.occurredAt} /> : null}
                <article
                  className={`max-w-[42rem] rounded-2xl border p-3 text-sm shadow-sm ${
                    outbound
                      ? 'ml-auto rounded-br-sm border-primary-100 bg-primary-50 text-neutral-900'
                      : 'mr-auto rounded-bl-sm border-neutral-200 bg-white text-neutral-900'
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-3 text-[11px] tracking-wide text-neutral-400">
                    <span className="font-medium uppercase">
                      {sender}
                      {outbound ? (
                        <span className="ml-1 normal-case text-primary-500">· sent by us</span>
                      ) : m.direction === 'inbound' ? (
                        <span className="ml-1 normal-case text-neutral-400">· customer</span>
                      ) : null}
                    </span>
                    <time dateTime={m.occurredAt.toISOString()}>
                      {formatRelativeTime(m.occurredAt, now)}
                    </time>
                  </div>
                  <p className="whitespace-pre-wrap break-words">
                    {displayMessageBody(m.body) ?? '(no content)'}
                  </p>
                  <Attachments
                    messageId={m.id}
                    attachments={m.attachments}
                    mailAttachments={m.mailAttachments}
                  />
                </article>
              </Fragment>
            )
          })
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-neutral-200 bg-white">
        <div className="flex items-center gap-1 px-3 pt-2">
          <TabButton active={tab === 'reply'} onClick={() => setTab('reply')}>
            Reply
          </TabButton>
          <TabButton active={tab === 'comment'} onClick={() => setTab('comment')}>
            Internal note
          </TabButton>
        </div>
        <div className="p-3">
          {tab === 'comment' ? (
            <ConversationNotes conversationId={head.id} />
          ) : isEmail ? (
            <EmailReply conversationId={head.id} />
          ) : canReplyTrengo ? (
            <ConversationReply
              conversationId={head.id}
              contactId={head.contactId as string}
              ticketId={head.trengoTicketId as number}
              status={head.status}
              channel={head.channel}
              contactName={head.contactName}
              contactPhone={head.contactPhone}
              latestInteractionId={latestInteractionId}
              replyWindowOpen={
                head.channel === 'whatsapp' && head.replyDeadlineAt
                  ? !!replyWindowOpen
                  : null
              }
            />
          ) : (
            <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
              This conversation is not yet matched to a contact. Match it to a contact before
              replying from the CRM — add it as an internal note in the meantime.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DaySeparator({ date }: { date: Date }) {
  return (
    <div className="flex items-center gap-3 py-1" role="separator">
      <span className="h-px flex-1 bg-neutral-200" />
      <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
        {new Intl.DateTimeFormat('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(date)}
      </span>
      <span className="h-px flex-1 bg-neutral-200" />
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? 'rounded-t-md border-b-2 border-primary-600 px-3 py-1.5 text-sm font-medium text-primary-700'
          : 'rounded-t-md border-b-2 border-transparent px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-800'
      }
    >
      {children}
    </button>
  )
}

interface TrengoAttachment {
  attachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number | null
  status: string
}
interface MailAttachment {
  index: number
  filename: string
  mimeType: string
  sizeBytes: number | null
  stored: boolean
}

function Attachments({
  messageId,
  attachments,
  mailAttachments,
}: {
  messageId: string
  attachments: TrengoAttachment[]
  mailAttachments: MailAttachment[]
}) {
  if (attachments.length === 0 && mailAttachments.length === 0) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((a) => {
        const stored = a.status === 'stored'
        const href = stored
          ? `/api/internal/trengo-attachments/${messageId}/${encodeURIComponent(a.attachmentId)}`
          : null
        const label = `${a.filename}${
          a.sizeBytes ? ` · ${Math.max(1, Math.round(a.sizeBytes / 1024))} KB` : ''
        }`
        if (!href) {
          return (
            <li
              key={a.attachmentId}
              className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600"
              title={`Attachment ${a.status}`}
            >
              {label}
              <span className="font-mono text-[10px] text-neutral-500">({a.status})</span>
            </li>
          )
        }
        return (
          <li key={a.attachmentId}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 text-xs text-primary-800 hover:bg-primary-100"
            >
              {label}
            </a>
          </li>
        )
      })}
      {mailAttachments.map((a) => (
        <li key={a.index}>
          <a
            href={`/api/internal/mail-attachments/${messageId}/${a.index}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-xs text-neutral-700 hover:border-primary-300 hover:text-primary-700"
          >
            {a.filename}
            {a.sizeBytes ? (
              <span className="text-neutral-400">
                {Math.max(1, Math.round(a.sizeBytes / 1024))} KB
              </span>
            ) : null}
          </a>
        </li>
      ))}
    </ul>
  )
}
