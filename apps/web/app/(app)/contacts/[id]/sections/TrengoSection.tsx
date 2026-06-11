// Trengo conversations section. RSC card list rendered as Trengo-style mini
// threads: the customer's messages on the left (named), ours on the right
// (named agent, primary tint) — so it is always obvious who said what. The
// WhatsApp 24h reply deadline is surfaced as an inline pill so agents know
// when the window closes. Per-card Close / Reopen actions are mounted as a
// client island (TrengoConversationActions) so the state change PATCHes
// Trengo via the audited outbound and updates immediately on success.

import Link from 'next/link'

import { displayMessageBody } from '@/lib/format/html-text'
import type { TrengoConversation } from '@/lib/view-models/contact-channels'

import { StartTrengoConversation } from './StartTrengoConversation'
import { TrengoConversationActions } from './TrengoConversationActions'

interface Props {
  contactId: string
  conversations: TrengoConversation[]
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  web_chat: 'Web chat',
}

const PREVIEW_BODY_CHARS = 600

export function TrengoSection({ contactId, conversations }: Props): JSX.Element {
  if (conversations.length === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-600">
          No Trengo conversations yet — WhatsApp, SMS, email, and web-chat
          threads will appear here once they are linked to this contact.
        </div>
        <StartTrengoConversation contactId={contactId} />
      </div>
    )
  }
  const now = Date.now()
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/inbox/conversations"
          className="text-xs text-primary-700 hover:underline"
        >
          Open the Trengo inbox →
        </Link>
        <StartTrengoConversation contactId={contactId} />
      </div>
      <ol className="space-y-2">
      {conversations.map((c) => {
        const windowOpen = c.replyDeadlineAt
          ? new Date(c.replyDeadlineAt).getTime() > now
          : false
        return (
          <li
            key={c.conversationId}
            className="rounded-md border border-neutral-200 bg-white px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
              <span className="flex items-center gap-2">
                <span className="font-medium text-neutral-800">
                  {c.channel ? (CHANNEL_LABEL[c.channel] ?? c.channel) : 'Conversation'}
                </span>
                {c.ticketStatus && (
                  <span className="rounded bg-neutral-100 px-1.5 text-[10px] uppercase text-neutral-600">
                    {c.ticketStatus}
                  </span>
                )}
                <span>· {c.messageCount} message{c.messageCount === 1 ? '' : 's'}</span>
                {c.channel === 'whatsapp' && c.replyDeadlineAt && (
                  <span
                    className={`rounded px-1.5 text-[10px] ${
                      windowOpen ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
                    }`}
                  >
                    {windowOpen ? '24h window open' : '24h window closed'}
                  </span>
                )}
                {c.latestStatus && c.latestStatus !== 'sent' && (
                  <span
                    className={`rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide ${
                      c.latestStatus === 'failed'
                        ? 'bg-red-50 text-red-800'
                        : 'bg-amber-50 text-amber-800'
                    }`}
                  >
                    {c.latestStatus}
                  </span>
                )}
              </span>
              <time dateTime={new Date(c.latestAt).toISOString()}>
                {new Intl.DateTimeFormat('en-GB', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(c.latestAt))}
              </time>
            </div>

            {/* The thread itself — customer left, us right, named senders. */}
            {c.messages.length > 0 ? (
              <ol className="mt-2 space-y-1.5">
                {c.messages.map((m) => {
                  const outbound = m.direction === 'outbound'
                  const body = displayMessageBody(m.body)
                  const truncated =
                    body && body.length > PREVIEW_BODY_CHARS
                      ? `${body.slice(0, PREVIEW_BODY_CHARS)}…`
                      : body
                  return (
                    <li
                      key={m.id}
                      className={`max-w-[85%] rounded-lg border px-2.5 py-1.5 text-sm ${
                        outbound
                          ? 'ml-auto rounded-br-sm border-primary-100 bg-primary-50 text-neutral-900'
                          : 'mr-auto rounded-bl-sm border-neutral-200 bg-neutral-50 text-neutral-900'
                      }`}
                    >
                      <div className="mb-0.5 flex items-baseline justify-between gap-3 text-[10px] text-neutral-500">
                        <span className="font-semibold uppercase tracking-wide">
                          {outbound
                            ? `${m.senderName ?? 'StudyMind'} · us`
                            : `${m.senderName ?? 'Customer'} · customer`}
                        </span>
                        <time dateTime={new Date(m.occurredAt).toISOString()}>
                          {new Intl.DateTimeFormat('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          }).format(new Date(m.occurredAt))}
                        </time>
                      </div>
                      <p className="whitespace-pre-wrap break-words">
                        {truncated ?? '(no content)'}
                      </p>
                    </li>
                  )
                })}
              </ol>
            ) : c.latestSnippet ? (
              <p className="mt-1 text-sm text-neutral-800">{c.latestSnippet}</p>
            ) : null}

            {c.latestError && (
              <p className="mt-1 text-xs text-red-700">
                Trengo rejected the send: {c.latestError}. It retries automatically
                every 5 minutes — if this keeps failing, check your token in
                Account → Trengo.
              </p>
            )}
            <TrengoConversationActions
              contactId={contactId}
              conversationId={c.conversationId}
              ticketStatus={c.ticketStatus}
            />
          </li>
        )
      })}
      </ol>
    </div>
  )
}
