// Inbox. CLAUDE.md §11 (inbound messages), §20 (role-gated), §26 (RSC by
// default, dense lists, plain-English empty states).
//
// Lists recent inbound message Interactions across all conversations. Each
// row links to the related Contact detail. Pagination is cursor-based; this
// page renders only the first slice — paging comes with the client list.

import Link from 'next/link'
import { TRPCError } from '@trpc/server'

import { createServerCaller } from '@/lib/trpc/server'

import { InboxRowActions } from './InboxRowActions'

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  web_chat: 'Web chat',
}

export default async function InboxPage() {
  const caller = await createServerCaller()
  let items: Awaited<ReturnType<typeof caller.inbox.list>>['items'] = []
  let forbidden = false
  try {
    const res = await caller.inbox.list({ limit: 50 })
    items = res.items
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      forbidden = true
    } else {
      throw err
    }
  }

  if (forbidden) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="mt-2 text-sm text-neutral-600">
          You need an agent, ops, DSL, or admin role to view the inbox.
        </p>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Recent inbound messages across all channels. Click a row to open the
        related Contact and reply.
      </p>

      {items.length === 0 ? (
        <div className="mt-8 rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-700">
          No inbound messages yet. New WhatsApp, SMS, email, and web-chat
          messages will appear here as they land.
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
          {items.map((item) => {
            const href = item.contactId
              ? `/contacts/${item.contactId}`
              : '/inbox'
            const channelLabel =
              item.channel && CHANNEL_LABEL[item.channel]
                ? CHANNEL_LABEL[item.channel]
                : (item.channel ?? 'Message')
            return (
              <li key={item.id} className="p-3 transition hover:bg-neutral-50">
                <div className="flex items-start justify-between gap-4">
                  <Link href={href} className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-700">
                        {channelLabel}
                      </span>
                      <span className="font-medium text-neutral-900">
                        {item.summary ?? 'Inbound message'}
                      </span>
                      {!item.contactId ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          Unassigned
                        </span>
                      ) : null}
                    </div>
                    {item.preview ? (
                      <p className="mt-1 truncate text-sm text-neutral-700">
                        {item.preview}
                      </p>
                    ) : null}
                  </Link>
                  <div className="shrink-0 font-mono text-xs text-neutral-500 tabular-nums">
                    {item.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </div>
                </div>
                <div className="mt-2">
                  <InboxRowActions
                    interactionId={item.id}
                    contactId={item.contactId}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
