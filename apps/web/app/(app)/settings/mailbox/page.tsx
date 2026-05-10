// Mailbox settings — connect/disconnect Gmail per agent. ADR 0012, §14.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { DisconnectGmailButton } from './disconnect-button'

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Mailbox', href: '/settings/mailbox' },
]

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

function fmt(date: Date | null | undefined): string {
  if (!date) return '—'
  return new Date(date).toUTCString()
}

export default async function MailboxSettingsPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {}
  const errorParam = typeof params.error === 'string' ? params.error : null
  const connectedParam = typeof params.connected === 'string'
  const warningParam = typeof params.warning === 'string' ? params.warning : null

  const trpc = await createServerCaller()
  const status = await trpc.oauth.gmail.status()

  return (
    <>
      <PageHeader
        title="Mailbox"
        subtitle="Connect your Gmail mailbox so messages, sent items, and drafts appear in your CRM timeline. Per-agent — your token is scoped to you and never shared."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <div className="max-w-2xl">
      {errorParam ? (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          We couldn't connect your mailbox: <code>{errorParam}</code>. Try
          reconnecting; if the problem persists, contact support.
        </div>
      ) : null}
      {connectedParam ? (
        <div className="mt-4 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">
          Mailbox connected.
          {warningParam === 'watch_setup_failed'
            ? ' (Background sync did not start — try reconnecting.)'
            : null}
        </div>
      ) : null}

      <div className="mt-6 rounded-md border border-neutral-200 bg-white p-4 shadow-sm">
        {status.status === 'connected' ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-neutral-900">
                  Connected
                </div>
                <div className="text-sm text-neutral-600">
                  {status.address ?? 'unknown address'}
                </div>
              </div>
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                connected
              </span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-neutral-500">Latest history id</dt>
              <dd className="font-mono text-neutral-800">
                {status.historyId ?? '—'}
              </dd>
              <dt className="text-neutral-500">Watch expires</dt>
              <dd className="text-neutral-800">{fmt(status.watchExpiresAt)}</dd>
            </dl>
            <div className="mt-4">
              <DisconnectGmailButton />
            </div>
          </>
        ) : status.status === 'needs_reconnect' ? (
          <>
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Reconnect required — your refresh token is no longer valid.
              Background sync is paused.
            </div>
            <div className="mt-4">
              <a
                href="/api/oauth/gmail/connect"
                className="inline-flex items-center rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
              >
                Reconnect Gmail
              </a>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-neutral-700">
              No mailbox connected.
            </div>
            <div className="mt-4">
              <a
                href="/api/oauth/gmail/connect"
                className="inline-flex items-center rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
              >
                Connect Gmail
              </a>
            </div>
          </>
        )}
      </div>
        </div>
      </PageBody>
    </>
  )
}
