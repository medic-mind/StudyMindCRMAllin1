// Settings → Integrations → <provider> detail. Surfaces env-var presence,
// recent received webhooks, last cron run for the provider's refresh jobs,
// per-agent connection state (Gmail / Trengo), and a setup checklist when
// the integration is not yet configured. Read-only and gated to
// ceo | senior_manager | manager (ADR 0014).
//
// CLAUDE.md §11, §13, §14, §25, §27.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { IntegrationTestButton } from '../IntegrationTestButton'

const VIEW_ROLES = new Set(['ceo', 'senior_manager', 'manager'])
const TEST_ROLES = new Set(['ceo', 'senior_manager'])

const PROVIDERS = [
  'stripe',
  'gocardless',
  'aircall',
  'trengo',
  'slack',
  'asana',
  'gmail',
  'booking',
  'lead',
] as const
type Provider = (typeof PROVIDERS)[number]

function isProvider(value: string): value is Provider {
  return (PROVIDERS as ReadonlyArray<string>).includes(value)
}

export const dynamic = 'force-dynamic'

function formatDateTime(d: Date | null): string {
  if (!d) return 'never'
  return d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
}

function statusPill(status: string): { tone: string; label: string } {
  switch (status) {
    case 'connected':
      return { tone: 'bg-emerald-100 text-emerald-900', label: 'Connected' }
    case 'needs_attention':
      return { tone: 'bg-amber-100 text-amber-900', label: 'Needs attention' }
    case 'not_configured':
    default:
      return { tone: 'bg-neutral-200 text-neutral-800', label: 'Not configured' }
  }
}

interface PageProps {
  params: Promise<{ provider: string }>
}

export default async function IntegrationDetailPage({ params }: PageProps) {
  const { provider: providerParam } = await params
  if (!isProvider(providerParam)) {
    notFound()
  }
  const provider: Provider = providerParam

  const me = await getCurrentUser()
  if (!me || !VIEW_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader
          title="Integration"
          breadcrumbs={[
            { label: 'Settings', href: '/settings' },
            { label: 'Integrations', href: '/settings/integrations' },
          ]}
        />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need the Manager, Senior Manager, or CEO role to view this
            integration.
          </p>
        </PageBody>
      </>
    )
  }

  const caller = await createServerCaller()
  let detail: Awaited<ReturnType<typeof caller.admin.integrations.detail>>
  try {
    detail = await caller.admin.integrations.detail({ provider })
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      return (
        <PageBody>
          <p className="text-sm text-neutral-600">Forbidden.</p>
        </PageBody>
      )
    }
    throw err
  }

  const pill = statusPill(detail.status)
  const canTest = TEST_ROLES.has(me.role)

  return (
    <>
      <PageHeader
        title={detail.label}
        breadcrumbs={[
          { label: 'Settings', href: '/settings' },
          { label: 'Integrations', href: '/settings/integrations' },
          { label: detail.label, href: `/settings/integrations/${provider}` },
        ]}
        subtitle={detail.description}
        actions={
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-2 py-1 text-xs font-medium ${pill.tone}`}
            >
              {pill.label}
            </span>
            {canTest ? <IntegrationTestButton provider={provider} /> : null}
          </div>
        }
      />
      <PageBody>
        <div className="space-y-8">
          {detail.status === 'not_configured' ? (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                Setup checklist
              </h2>
              <p className="mt-1 text-xs text-neutral-500">
                Follow these steps to configure {detail.label}. After the
                env vars are set in Railway, redeploy and refresh this page.
              </p>
              <ol className="mt-3 space-y-3">
                {detail.setupSteps.map((step, i) => (
                  <li
                    key={i}
                    className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-xs text-neutral-500">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <div className="text-sm font-medium text-neutral-900">
                        {step.title}
                      </div>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-700">
                      {step.body}
                    </p>
                  </li>
                ))}
              </ol>
              {detail.providerDashboardUrl ? (
                <p className="mt-3 text-sm">
                  <a
                    href={detail.providerDashboardUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-700 hover:underline"
                  >
                    Open the {detail.label} dashboard →
                  </a>
                </p>
              ) : null}
            </section>
          ) : null}

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
              Configuration
            </h2>
            <p className="mt-1 text-xs text-neutral-500">
              Required environment variables. Values are never displayed —
              only their presence. Rotate via the{' '}
              <Link
                href={detail.runbook}
                className="text-primary-700 hover:underline"
              >
                secret rotation runbook
              </Link>
              .
            </p>
            <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
              <Table>
                <Thead>
                  <Tr>
                    <Th>Variable</Th>
                    <Th>Set?</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {detail.envVars.map((v) => (
                    <Tr key={v.name}>
                      <Td className="font-mono text-xs">{v.name}</Td>
                      <Td>
                        {v.isSet ? (
                          <Badge tone="success">set</Badge>
                        ) : (
                          <Badge tone="danger">missing</Badge>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          </section>

          {detail.perAgent ? (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                Per-agent connections
              </h2>
              <p className="mt-1 text-xs text-neutral-500">
                {detail.perAgent.length === 0
                  ? `No agents have connected ${detail.label} yet.`
                  : `${detail.perAgent.length} agent${detail.perAgent.length === 1 ? '' : 's'} connected.`}
              </p>
              {detail.perAgent.length > 0 ? (
                <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>Agent</Th>
                        <Th>Expires</Th>
                        <Th>State</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {detail.perAgent.map((a) => (
                        <Tr key={a.agentId}>
                          <Td className="font-mono text-xs">{a.label}</Td>
                          <Td className="font-mono text-xs tabular-nums">
                            {formatDateTime(a.expiresAt)}
                          </Td>
                          <Td>
                            {a.expired ? (
                              <Badge tone="danger">expired</Badge>
                            ) : a.expiringSoon ? (
                              <Badge tone="warn">expiring soon</Badge>
                            ) : (
                              <Badge tone="success">healthy</Badge>
                            )}
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </div>
              ) : null}
            </section>
          ) : null}

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
              Recent webhooks
            </h2>
            {detail.recentEvents.length === 0 ? (
              <p className="mt-3 rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-600 shadow-sm">
                No events received from {detail.label} yet. Use the{' '}
                <strong>Test webhook</strong> button above to insert a
                synthetic event and confirm the persistence path is healthy.
              </p>
            ) : (
              <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
                <Table>
                  <Thead>
                    <Tr>
                      <Th>Received</Th>
                      <Th>Type</Th>
                      <Th>Event id</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {detail.recentEvents.map((e) => (
                      <Tr key={e.id}>
                        <Td className="font-mono text-xs tabular-nums">
                          {formatDateTime(e.receivedAt)}
                        </Td>
                        <Td className="font-mono text-xs">{e.type}</Td>
                        <Td className="truncate font-mono text-xs text-neutral-500">
                          {e.eventId}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </div>
            )}
          </section>

          {detail.recentCronRuns.length > 0 ? (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                Recent cron runs
              </h2>
              <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
                <Table>
                  <Thead>
                    <Tr>
                      <Th>Finished</Th>
                      <Th>Function</Th>
                      <Th>Duration</Th>
                      <Th>Result</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {detail.recentCronRuns.map((r) => (
                      <Tr key={r.id}>
                        <Td className="font-mono text-xs tabular-nums">
                          {formatDateTime(r.finishedAt)}
                        </Td>
                        <Td className="font-mono text-xs">{r.functionId}</Td>
                        <Td className="font-mono text-xs tabular-nums">
                          {r.durationMs}ms
                        </Td>
                        <Td>
                          {r.success ? (
                            <Badge tone="success">ok</Badge>
                          ) : (
                            <Badge tone="danger">{r.errorCode ?? 'failed'}</Badge>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </div>
            </section>
          ) : null}
        </div>
      </PageBody>
    </>
  )
}
