// Email threads section. Each thread is a collapsible card. Reply lives on
// the deepest inbound message via the existing EmailReplyPanel client
// island.

'use client'

import { useState } from 'react'

import type { EmailThread } from '@/lib/view-models/contact-channels'
import { EmailHtmlBody } from '@/components/mail/email-html-body'
import { EmailReplyPanel } from '@/components/contact/EmailReplyPanel'

interface Props {
  threads: EmailThread[]
}

function relativeTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function ThreadCard({ thread }: { thread: EmailThread }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-md border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-neutral-50"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-900">
              {thread.subject ?? '(no subject)'}
            </span>
            {thread.unreadCount > 0 && (
              <span className="rounded bg-blue-100 px-1.5 text-[10px] font-semibold uppercase text-blue-900">
                {thread.unreadCount} unread
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-neutral-600">
            {thread.participantEmails.slice(0, 3).join(', ')}
            {thread.participantEmails.length > 3 && ' …'}
            <span className="mx-1">·</span>
            {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
            <span className="mx-1">·</span>
            <time dateTime={new Date(thread.latestAt).toISOString()}>
              {relativeTime(thread.latestAt)}
            </time>
          </div>
          {!open && thread.latestSnippet && (
            <div className="mt-1 line-clamp-1 text-xs text-neutral-700">
              {thread.latestSnippet}
            </div>
          )}
        </div>
      </button>
      {open && (
        <ol className="border-t border-neutral-200">
          {thread.messages.map((m) => (
            <li key={m.id} className="border-b border-neutral-100 px-3 py-2 last:border-b-0">
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span>
                  {m.direction === 'sent' ? 'Sent' : 'Received'} ·{' '}
                  {m.direction === 'sent'
                    ? m.to.join(', ')
                    : (m.from[0] ?? '—')}
                </span>
                <time dateTime={new Date(m.occurredAt).toISOString()}>
                  {relativeTime(m.occurredAt)}
                </time>
              </div>
              {m.bodyHtml || m.gmailMessageId ? (
                // The real email — rich HTML in the shared reading pane (falls
                // back to a plain-text preview via its toggle). Same component
                // as /mail; the render route is access-gated per contact.
                <div className="mt-2">
                  <EmailHtmlBody interactionId={m.id} text={m.snippet ?? ''} height={340} />
                </div>
              ) : m.snippet ? (
                <div className="mt-1 whitespace-pre-wrap text-sm text-neutral-800">{m.snippet}</div>
              ) : null}
              {m.attachments.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {m.attachments.map((a) => (
                    <span
                      key={a.s3Key}
                      className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-700"
                    >
                      {a.filename}
                    </span>
                  ))}
                </div>
              )}
              {m.direction === 'received' && (
                <div className="mt-2">
                  <EmailReplyPanel interactionId={m.id} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </li>
  )
}

export function EmailSection({ threads }: Props): JSX.Element {
  if (threads.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-600">
        No email threads yet — once Gmail is connected and a message arrives,
        threaded conversations will appear here.
      </div>
    )
  }
  return (
    <ol className="space-y-2">
      {threads.map((t) => (
        <ThreadCard key={t.threadId} thread={t} />
      ))}
    </ol>
  )
}
