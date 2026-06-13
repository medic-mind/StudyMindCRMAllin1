// Mailbox settings — connect/disconnect Gmail per agent. ADR 0012, §14.
// Supports multiple connected mailboxes per agent: the first connected
// becomes the default and drives outbound + Trengo / board email sends.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { MailIcon } from '@/components/ui/icon'
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

// Friendly, actionable copy for the OAuth error codes the connect flow can
// redirect back with (CLAUDE.md §4 — say what failed and what to do now).
function connectErrorMessage(code: string): string {
  if (code === 'gmail_api_disabled') {
    return 'Gmail is connected, but the Gmail API is switched off in your Google Cloud project. Enable the Gmail API for the same project as your OAuth client, wait a few minutes for it to propagate, then connect again.'
  }
  if (code === 'connect_failed') {
    return 'Sign-in succeeded but the server hit an error finishing the connection. This is usually a missing server setting (the encryption key, AUTH_SECRET, or the app URL). The exact cause was recorded in the audit log — check the server logs, then try again.'
  }
  if (code.startsWith('profile_lookup_failed')) {
    return "Google approved the sign-in but rejected the first Gmail request. This is usually the Gmail API not being enabled yet (give it a few minutes after enabling), or the account not being a test user on the OAuth consent screen."
  }
  if (code === 'oauth_not_configured') {
    return 'Gmail OAuth is not configured on the server. Set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / NEXT_PUBLIC_APP_URL and redeploy.'
  }
  if (code === 'scope_mismatch') {
    return 'Some Gmail permissions were not granted. When Google asks, tick all the requested boxes and continue.'
  }
  if (code === 'no_refresh_token') {
    return 'Google did not return a refresh token. Remove this app at myaccount.google.com → Security → Third-party access, then connect again.'
  }
  if (code === 'token_exchange_failed' || code === 'oauth_not_configured') {
    return 'We could not exchange the sign-in code. Check the OAuth client secret and that the redirect URI matches exactly.'
  }
  if (code === 'invalid_state' || code === 'invalid_request') {
    return 'The sign-in link expired or was reused. Start the connection again from this page.'
  }
  return 'We could not connect that mailbox. Try again; if it persists, contact support.'
}

export default async function MailboxSettingsPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {}
  const errorParam = typeof params.error === 'string' ? params.error : null
  const connectedParam = typeof params.connected === 'string'
  const warningParam = typeof params.warning === 'string' ? params.warning : null

  const trpc = await createServerCaller()
  const data = await trpc.oauth.gmail.list()
  const mailboxes = data.mailboxes
  const needsReconnect = data.connectionStatus === 'needs_reconnect'

  return (
    <>
      <PageHeader
        title="Mailboxes"
        subtitle="Connect one or more Gmail accounts. The default mailbox drives outbound for Trengo + board call summaries."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <div className="max-w-3xl space-y-5">
          {errorParam ? (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
              <p>{connectErrorMessage(errorParam)}</p>
              <p className="mt-1 text-xs text-red-700/80">
                Reference: <code>{errorParam}</code>
              </p>
            </div>
          ) : null}
          {connectedParam ? (
            <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">
              Mailbox connected.
              {warningParam === 'watch_setup_failed'
                ? ' (Background sync did not start — try reconnecting.)'
                : null}
            </div>
          ) : null}
          {needsReconnect ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Reconnect required — the most-recently-connected Gmail token
              is no longer valid. Background sync is paused until you
              reconnect.
            </div>
          ) : null}

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-neutral-100 bg-neutral-50/60 px-4 py-3">
              <h2 className="text-sm font-semibold text-neutral-900">
                Connected accounts ({mailboxes.length})
              </h2>
              <a
                href="/api/oauth/gmail/connect"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-700"
              >
                <MailIcon size={14} />
                {mailboxes.length === 0 ? 'Connect Gmail' : 'Connect another'}
              </a>
            </div>

            {mailboxes.length === 0 ? (
              <div className="p-6 text-sm text-neutral-500">
                No Gmail accounts connected yet. Click <strong>Connect Gmail</strong>
                {' '}above to begin — messages, sent items, and drafts will start
                landing on this contact&apos;s timeline.
              </div>
            ) : (
              <ul className="divide-y divide-neutral-100">
                {mailboxes.map((m) => (
                  <li key={m.id} className="flex items-start gap-4 px-4 py-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700">
                      <MailIcon size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-neutral-900">
                          {m.address}
                        </span>
                        {m.isDefault ? (
                          <Badge tone="info" dot>
                            Default
                          </Badge>
                        ) : null}
                      </div>
                      <dl className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-neutral-500">
                        <div className="inline-flex gap-1.5">
                          <dt>Latest history</dt>
                          <dd className="font-mono text-neutral-700">
                            {m.historyId ?? '—'}
                          </dd>
                        </div>
                        <div className="inline-flex gap-1.5">
                          <dt>Watch expires</dt>
                          <dd className="text-neutral-700">{fmt(m.watchExpiresAt)}</dd>
                        </div>
                        <div className="inline-flex gap-1.5">
                          <dt>Connected</dt>
                          <dd className="text-neutral-700">{fmt(m.createdAt)}</dd>
                        </div>
                      </dl>
                    </div>
                    {m.isDefault ? <DisconnectGmailButton /> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {mailboxes.length > 1 ? (
            <p className="text-xs text-neutral-500">
              Multiple accounts are listed for visibility. Today only the
              default mailbox holds an active refresh token (re-connecting any
              account replaces it). Full multi-account token storage is
              tracked for the next iteration.
            </p>
          ) : null}
        </div>
      </PageBody>
    </>
  )
}
