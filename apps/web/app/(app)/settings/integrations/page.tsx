// Settings → Integrations status. RSC, admin | ops_manager.
// Read-only view of webhook receive recency and connected-mailbox health.
// CLAUDE.md §11 (Trengo), §13 (Asana), §14 (Gmail), §25 (observability).

import { legacyAuth as auth } from '@/lib/auth/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { IntegrationTestButton } from './IntegrationTestButton'

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Integrations', href: '/settings/integrations' },
]

export const dynamic = 'force-dynamic'

function timeAgo(d: Date | null): string {
  if (!d) return 'never'
  const ms = Date.now() - d.getTime()
  const min = Math.floor(ms / (1000 * 60))
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function freshness(d: Date | null): 'green' | 'amber' | 'red' | 'grey' {
  if (!d) return 'grey'
  const ms = Date.now() - d.getTime()
  if (ms < 1000 * 60 * 60) return 'green'
  if (ms < 1000 * 60 * 60 * 24) return 'amber'
  return 'red'
}

const DOT: Record<'green' | 'amber' | 'red' | 'grey', string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  grey: 'bg-neutral-300',
}

export default async function IntegrationsSettingsPage() {
  const { sessionClaims } = await auth()
  const role = (sessionClaims?.['role'] as string | undefined) ?? 'agent'
  if (role !== 'admin' && role !== 'ops_manager') {
    return (
      <>
        <PageHeader title="Integrations" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            Restricted to administrators and ops managers.
          </p>
        </PageBody>
      </>
    )
  }
  const caller = await createServerCaller()
  const data = await caller.admin.integrations.status()
  const isAdmin = role === 'admin'

  return (
    <>
      <PageHeader title="Integrations" breadcrumbs={BREADCRUMBS} />
      <PageBody>
      <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
        Webhook receive
      </h2>
      <div className="mt-2 rounded-md border border-neutral-200 bg-white">
        <Table>
          <Thead>
            <Tr>
              <Th>Provider</Th>
              <Th>Last event</Th>
              <Th>Type</Th>
              <Th>Event id</Th>
              {isAdmin ? <Th>Actions</Th> : null}
            </Tr>
          </Thead>
          <Tbody>
            {data.providers.map((p) => {
              const f = freshness(p.lastReceivedAt)
              return (
                <Tr key={p.provider}>
                  <Td className="font-mono text-xs">
                    <span className={`mr-2 inline-block h-2 w-2 rounded-full ${DOT[f]}`} />
                    {p.provider}
                  </Td>
                  <Td className="text-xs">{timeAgo(p.lastReceivedAt)}</Td>
                  <Td className="font-mono text-xs text-neutral-600">
                    {p.lastEventType ?? '—'}
                  </Td>
                  <Td className="font-mono text-xs text-neutral-500">
                    {p.lastEventId ?? '—'}
                  </Td>
                  {isAdmin ? (
                    <Td>
                      <IntegrationTestButton provider={p.provider as never} />
                    </Td>
                  ) : null}
                </Tr>
              )
            })}
          </Tbody>
        </Table>
      </div>

      <h2 className="mt-8 text-sm font-semibold text-neutral-600 uppercase tracking-wide">
        Gmail mailboxes
      </h2>
      <div className="mt-2 rounded-md border border-neutral-200 bg-white p-4 text-sm">
        <p>
          {data.gmail.connectedAgents} connected mailbox
          {data.gmail.connectedAgents === 1 ? '' : 'es'}.
          {data.gmail.expiringSoon > 0 ? (
            <span className="ml-1 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
              {data.gmail.expiringSoon} watch expir{data.gmail.expiringSoon === 1 ? 'es' : 'e'}{' '}
              within 24h
            </span>
          ) : null}
        </p>
        {data.gmail.mailboxes.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs">
            {data.gmail.mailboxes.map((m) => (
              <li key={m.agentId} className="font-mono text-neutral-600">
                {m.address} — watch expires{' '}
                {m.watchExpiresAt ? timeAgo(m.watchExpiresAt) : 'unknown'}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <h2 className="mt-8 text-sm font-semibold text-neutral-600 uppercase tracking-wide">
        Asana
      </h2>
      <div className="mt-2 rounded-md border border-neutral-200 bg-white p-4 text-sm">
        <p>{data.asana.webhooks} webhook(s) registered (project-scoped).</p>
      </div>
      </PageBody>
    </>
  )
}
