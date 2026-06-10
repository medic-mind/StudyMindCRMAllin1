// Trengo conversations section. RSC card list; the WhatsApp 24h reply
// deadline is surfaced as an inline pill so agents know when the window
// closes. Per-card Close / Reopen actions are mounted as a client island
// (TrengoConversationActions) so the state change PATCHes Trengo via the
// audited outbound and updates immediately on success.

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
      <div className="flex justify-end">
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
            {c.latestSnippet && (
              <p className="mt-1 text-sm text-neutral-800">{c.latestSnippet}</p>
            )}
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
