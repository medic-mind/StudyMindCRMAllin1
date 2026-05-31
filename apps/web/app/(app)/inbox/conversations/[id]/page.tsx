// Communication Centre thread view (ADR 0020 Phase 4). CLAUDE.md §11, §20, §26.
//
// Reads the Conversation head + the last 100 messages on the ticket and
// renders the thread with inline Reply / Close / Reopen actions when the
// conversation is matched to a contact. Unmatched conversations are
// surfaced read-only — there is no contact to attribute outbound to and
// the audited send refuses without one.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

import { LiveUpdates } from '../LiveUpdates'
import { getCurrentUser } from '@/lib/auth/server'

import { AssignControl } from './AssignControl'
import { ConversationNotes } from './ConversationNotes'
import { TrengoThreadActions } from './TrengoThreadActions'
import { ConversationReply } from './ConversationReply'
import { ConversationTaskButton } from './ConversationTaskButton'
import { EmailReply } from './EmailReply'
import { MailThreadActions } from './MailThreadActions'

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  web_chat: 'Web chat',
}

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  let data: Awaited<ReturnType<typeof caller.inbox.conversations.get>> | null = null
  let forbidden = false
  try {
    data = await caller.inbox.conversations.get({ conversationId: id })
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      forbidden = true
    } else if (err instanceof TRPCError && err.code === 'NOT_FOUND') {
      notFound()
    } else {
      throw err
    }
  }

  if (forbidden) {
    return (
      <>
        <PageHeader title="Conversation" subtitle="Communication Centre" />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need a staff role to view conversations.
          </p>
        </PageBody>
      </>
    )
  }
  if (!data) notFound()

  const { head, messages } = data
  const channelLabel =
    head.channel && CHANNEL_LABEL[head.channel]
      ? CHANNEL_LABEL[head.channel]
      : (head.channel ?? 'Conversation')
  const now = new Date()
  const replyWindowOpen =
    head.replyDeadlineAt && new Date(head.replyDeadlineAt).getTime() > now.getTime()

  return (
    <>
      <PageHeader
        title={head.contactName ?? 'Unmatched conversation'}
        subtitle={`${channelLabel}${head.trengoTicketId !== null ? ` · Ticket #${head.trengoTicketId}` : ''} · ${head.status}`}
      />
      <PageBody>
        <LiveUpdates />

        <nav aria-label="Back to list" className="mb-3 text-xs">
          <Link
            href="/inbox/conversations"
            className="text-primary-700 hover:underline"
          >
            ← All conversations
          </Link>
          {head.contactId ? (
            <>
              <span className="mx-2 text-neutral-400">·</span>
              <Link
                href={`/contacts/${head.contactId}`}
                className="text-primary-700 hover:underline"
              >
                Open contact
              </Link>
            </>
          ) : null}
        </nav>

        <header className="mb-4 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="neutral">{channelLabel}</Badge>
            {head.status === 'closed' ? (
              <Badge tone="neutral">Closed</Badge>
            ) : null}
            {head.status === 'snoozed' ? (
              <Badge tone="neutral">Snoozed</Badge>
            ) : null}
            {head.unreadCount > 0 ? (
              <Badge tone="warn">{head.unreadCount} unread</Badge>
            ) : null}
            {head.channel === 'whatsapp' && head.replyDeadlineAt ? (
              <span
                className={`rounded px-1.5 text-[10px] ${
                  replyWindowOpen
                    ? 'bg-green-50 text-green-800'
                    : 'bg-red-50 text-red-800'
                }`}
              >
                {replyWindowOpen ? '24h window open' : '24h window closed'}
              </span>
            ) : null}
          </div>
          {head.subject ? (
            <p className="mt-2 text-sm text-neutral-700">{head.subject}</p>
          ) : null}
          {me ? (
            <div className="mt-2 border-t border-neutral-100 pt-2">
              <ConversationTaskButton
                contactId={head.contactId}
                meId={me.id}
                defaultTitle={`Follow up: ${
                  head.subject ?? head.contactName ?? 'conversation'
                }`.slice(0, 280)}
              />
            </div>
          ) : null}
        </header>

        {head.provider === 'email' ? (
          <MailThreadActions
            conversationId={head.id}
            unread={head.unreadCount > 0}
            archived={head.status === 'archived'}
          />
        ) : (
          <TrengoThreadActions
            conversationId={head.id}
            contactId={head.contactId}
            ticketId={head.trengoTicketId}
            tags={head.tags}
            unread={head.unreadCount > 0}
            status={head.status}
          />
        )}

        {messages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-600">
            No messages on this ticket yet.
          </div>
        ) : (
          <ol className="space-y-3">
            {messages.map((m) => {
              const isOutbound = m.direction === 'outbound'
              return (
                <li
                  key={m.id}
                  className={
                    isOutbound
                      ? 'ml-12 rounded-lg bg-primary-50 p-3 text-sm text-neutral-900'
                      : 'mr-12 rounded-lg border border-neutral-200 bg-white p-3 text-sm text-neutral-900'
                  }
                >
                  <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-neutral-500">
                    <span>
                      {m.direction === 'outbound'
                        ? 'You'
                        : m.direction === 'inbound'
                          ? 'Contact'
                          : 'System'}
                    </span>
                    <time dateTime={m.occurredAt.toISOString()}>
                      {formatRelativeTime(m.occurredAt, now)}
                    </time>
                  </div>
                  <p className="whitespace-pre-wrap break-words">
                    {m.body ?? '(no body)'}
                  </p>
                  {m.attachments.length > 0 ? (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {m.attachments.map((a) => {
                        const stored = a.status === 'stored'
                        const href = stored
                          ? `/api/internal/trengo-attachments/${m.id}/${encodeURIComponent(a.attachmentId)}`
                          : null
                        const label = `${a.filename}${
                          a.sizeBytes
                            ? ` · ${Math.round(a.sizeBytes / 1024)} KB`
                            : ''
                        }`
                        if (!href) {
                          return (
                            <li
                              key={a.attachmentId}
                              className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600"
                              title={`Attachment ${a.status}`}
                            >
                              {label}
                              <span className="font-mono text-[10px] text-neutral-500">
                                ({a.status})
                              </span>
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
                    </ul>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}

        <div className="mt-6">
          {head.provider === 'email' ? (
            <EmailReply conversationId={head.id} />
          ) : head.contactId && head.trengoTicketId !== null ? (
            <>
              <AssignControl
                conversationId={head.id}
                contactId={head.contactId}
                ticketId={head.trengoTicketId}
                assigneeUserId={head.assigneeUserId}
              />
              <ConversationReply
                conversationId={head.id}
                contactId={head.contactId}
                ticketId={head.trengoTicketId}
                status={head.status}
                channel={head.channel}
                contactName={head.contactName}
                latestInteractionId={messages[messages.length - 1]?.id ?? null}
              />
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
              This conversation is not yet matched to a contact. Match it to a
              contact before replying from the CRM.
            </div>
          )}
        </div>

        <ConversationNotes conversationId={head.id} />
      </PageBody>
    </>
  )
}
