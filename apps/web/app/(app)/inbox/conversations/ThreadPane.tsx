'use client'

// Centre pane of the cockpit: the open conversation's message thread plus the
// composer. ADR 0020. The composer is the existing audited island
// (ConversationReply for Trengo, EmailReply for Gmail) so replies still send on
// the right channel and sync back. A "Comment" tab swaps the reply box for the
// internal-notes island (staff-only). CLAUDE.md §11, §20, §26.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Fragment, useState } from 'react'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  CheckCircleIcon,
  ChevronLeftIcon,
  RepeatIcon,
  StarIcon,
  UserCircleIcon,
} from '@/components/ui/icon'
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
  const router = useRouter()
  const utils = trpc.useUtils()

  // Poll the open thread lightly so an inbound message that lands while you are
  // reading appears promptly. The list itself is kept live by the SSE stream.
  const convo = trpc.inbox.conversations.get.useQuery(
    { conversationId },
    // SSE (useConversationStream) is the primary live path; this poll is a
    // fallback, so 30s is plenty and keeps the thread light.
    { refetchInterval: 30_000, refetchOnWindowFocus: true },
  )

  // Trengo's signature header action: Close (✓) / Reopen the ticket from the
  // top of the thread, where Trengo puts it — not buried in the composer.
  const refreshConvo = () => {
    void utils.inbox.conversations.get.invalidate({ conversationId })
    void utils.inbox.conversations.list.invalidate()
    void utils.inbox.conversations.counts.invalidate()
    router.refresh()
  }
  const closeTicket = trpc.interaction.trengo.close.useMutation({
    onSuccess: () => {
      toast.success('Conversation closed in Trengo')
      refreshConvo()
    },
    onError: (e) => toast.error(e.message ?? 'Could not close conversation'),
  })
  const reopenTicket = trpc.interaction.trengo.reopen.useMutation({
    onSuccess: () => {
      toast.success('Conversation reopened in Trengo')
      refreshConvo()
    },
    onError: (e) => toast.error(e.message ?? 'Could not reopen conversation'),
  })
  const favorite = trpc.inbox.conversations.favorite.useMutation({
    onSuccess: () => {
      void utils.inbox.conversations.get.invalidate({ conversationId })
      void utils.inbox.conversations.list.invalidate()
      void utils.inbox.conversations.counts.invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not update favourite'),
  })

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
  // Seed for replies: the newest real MESSAGE (system separators are not
  // replyable rows).
  const latestInteractionId =
    [...messages].reverse().find((m) => m.kind === 'message')?.id ?? null
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
            {/* The SPECIFIC business number / inbox this is on (Trengo
                "Channel"), so it's clear which line you're replying from. */}
            {head.trengoChannelName ? (
              <span className="font-medium text-neutral-700">{head.trengoChannelName}</span>
            ) : null}
            <span>{channelLabelFor(head.channel)}</span>
            {head.trengoTicketId !== null ? (
              <span className="font-mono text-neutral-400">#{head.trengoTicketId}</span>
            ) : null}
          </div>
        </div>
        {head.status === 'closed' ? <Badge tone="neutral">Closed</Badge> : null}
        {head.status === 'snoozed' ? <Badge tone="warn">Snoozed</Badge> : null}
        {head.channel === 'whatsapp' && head.replyDeadlineAt ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              replyWindowOpen
                ? 'bg-success-50 text-success-700'
                : 'bg-warning-50 text-warning-700'
            }`}
          >
            {replyWindowOpen ? '24h open' : '24h closed'}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => favorite.mutate({ conversationId, on: !head.isFavorite })}
          disabled={favorite.isPending}
          aria-pressed={head.isFavorite}
          aria-label={head.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          title={head.isFavorite ? 'Favorited' : 'Add to favorites'}
          className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 disabled:opacity-50"
        >
          <StarIcon
            size={16}
            className={head.isFavorite ? 'fill-warning-400 text-warning-400' : ''}
          />
        </button>
        {head.contactId && head.trengoTicketId !== null ? (
          head.status === 'closed' ? (
            <button
              type="button"
              onClick={() =>
                reopenTicket.mutate({
                  contactId: head.contactId as string,
                  ticketId: head.trengoTicketId as number,
                })
              }
              disabled={reopenTicket.isPending}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              <RepeatIcon size={14} />
              {reopenTicket.isPending ? 'Reopening…' : 'Reopen'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                closeTicket.mutate({
                  contactId: head.contactId as string,
                  ticketId: head.trengoTicketId as number,
                })
              }
              disabled={closeTicket.isPending}
              title="Close this conversation in Trengo"
              className="inline-flex items-center gap-1.5 rounded-md bg-trengo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-trengo-700 disabled:opacity-50"
            >
              <CheckCircleIcon size={14} />
              {closeTicket.isPending ? 'Closing…' : 'Close'}
            </button>
          )
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
              className="rounded-full border border-trengo-200 bg-trengo-50 px-2 py-0.5 text-[10px] font-medium text-trengo-800"
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
            // Lifecycle rows ("Closed by Lizette at …") render as centred
            // system separators, exactly like Trengo's thread.
            if (m.kind === 'system') {
              return (
                <Fragment key={m.id}>
                  {newDay ? <DaySeparator date={m.occurredAt} /> : null}
                  <div className="py-1 text-center text-[11px] text-neutral-400">
                    {m.systemText ?? m.body ?? 'Updated'} ·{' '}
                    {new Intl.DateTimeFormat('en-GB', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(m.occurredAt)}
                  </div>
                </Fragment>
              )
            }
            const sender = outbound
              ? (m.senderName ?? 'You')
              : m.direction === 'inbound'
                ? (m.senderName ?? head.contactName ?? 'Customer')
                : 'System'
            // Group consecutive messages from the same side: only the first of
            // a run shows the sender name, so the thread reads calmly.
            const sameRunAsPrev =
              !!prev && prev.kind === 'message' && prev.direction === m.direction && !newDay
            return (
              <Fragment key={m.id}>
                {newDay ? <DaySeparator date={m.occurredAt} /> : null}
                <article
                  className={`max-w-[40rem] px-3.5 py-2 text-sm ${
                    outbound
                      ? 'ml-auto rounded-2xl rounded-br-md bg-trengo-600 text-white'
                      : 'mr-auto rounded-2xl rounded-bl-md bg-white text-neutral-900 ring-1 ring-neutral-200'
                  } ${sameRunAsPrev ? 'mt-1' : ''}`}
                >
                  {!sameRunAsPrev ? (
                    <div
                      className={`mb-0.5 text-[11px] font-medium ${
                        outbound ? 'text-white/70' : 'text-neutral-500'
                      }`}
                    >
                      {sender}
                    </div>
                  ) : null}
                  <p className="whitespace-pre-wrap break-words leading-relaxed">
                    {displayMessageBody(m.body) ?? '(no content)'}
                  </p>
                  <div
                    className={`mt-1 text-right text-[10px] tabular-nums ${
                      outbound ? 'text-white/60' : 'text-neutral-400'
                    }`}
                  >
                    {formatRelativeTime(m.occurredAt, now)}
                  </div>
                  {m.sendStatus === 'sending' ? (
                    <p
                      className={`mt-1 text-[11px] ${
                        outbound ? 'text-white/80' : 'text-neutral-500'
                      }`}
                    >
                      Sending…
                    </p>
                  ) : m.sendStatus === 'failed' ? (
                    <p
                      className={`mt-1 text-[11px] font-medium ${
                        outbound ? 'text-rose-100' : 'text-danger-600'
                      }`}
                      title={m.sendError ?? undefined}
                    >
                      Not delivered — retrying. {m.sendError ?? ''}
                    </p>
                  ) : null}
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
            Comment
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
          ? 'rounded-t-md border-b-2 border-trengo-600 px-3 py-1.5 text-sm font-medium text-trengo-700'
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
