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

import { AircallProbeButton } from './AircallProbeButton'
import { BackfillButton } from './BackfillButton'
import { TrengoImportButton } from './TrengoImportButton'
import { LeadIngestionPanel } from './LeadIngestionPanel'

const BACKFILL_PROVIDERS = new Set(['gmail', 'aircall', 'trengo', 'slack'])
const SHARED_TOKEN_BACKFILL = new Set(['aircall', 'slack'])

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

  // Background-job (Inngest) health. A backfill stuck `pending` or no cron ever
  // running, despite keys being set, means the app isn't synced to Inngest.
  const bj = detail.backgroundJobs
  const bjKeysSet = bj.inngestEventKeySet && bj.inngestSigningKeySet
  const bjStatus: { tone: 'success' | 'warn' | 'danger'; title: string; body: string } =
    !bjKeysSet
      ? {
          tone: 'danger',
          title: 'Not connected — jobs cannot run',
          body: 'Set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY on the web service in Railway, then in Inngest Cloud → Apps → Sync new app → https://<your-host>/api/inngest. Until then no background job runs: backfills stay pending, the 10-minute sync never fires, and webhook events are never processed.',
        }
      : bj.stuckBackfills > 0 || !bj.lastCronRunAt
        ? {
            tone: 'warn',
            title: 'Keys set, but jobs are not running',
            body: 'Inngest keys are present but no job has executed yet. In Inngest Cloud → Apps → Sync new app → https://<your-host>/api/inngest, then redeploy. Backfills stay pending until the worker picks them up.',
          }
        : {
            tone: 'success',
            title: 'Connected — background jobs are running',
            body: 'Inngest is invoking functions. Backfills and the 10-minute sync run normally.',
          }
  const bjTone: Record<'success' | 'warn' | 'danger', string> = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    danger: 'border-red-200 bg-red-50 text-red-900',
  }

  // ADR 0017: backfill history for the four backfillable providers.
  const isBackfillable = BACKFILL_PROVIDERS.has(provider)
  const backfillRuns = isBackfillable
    ? await caller.admin.backfill.list({
        provider: provider as 'gmail' | 'aircall' | 'trengo' | 'slack',
        limit: 10,
      })
    : []
  const showBackfillButton =
    SHARED_TOKEN_BACKFILL.has(provider) && TEST_ROLES.has(me.role)

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
          {provider === 'lead' ? <LeadIngestionPanel /> : null}

          {provider === 'aircall' && detail.importStats ? (
            <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                    Call import health
                  </h2>
                  <p className="mt-1 max-w-xl text-xs text-neutral-500">
                    Calls mirrored from Aircall (live webhooks + the 10-minute
                    sync). If these stay at 0 or look stale, all three env vars
                    below must be set, the Aircall webhook must point at{' '}
                    <code className="font-mono">/api/webhooks/aircall</code>, and
                    the worker must be deployed. Use “Test Aircall connection” to
                    check the API keys directly.
                  </p>
                </div>
                {canTest ? <AircallProbeButton /> : null}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: 'Total calls', value: String(detail.importStats.totalCalls) },
                  { label: 'Last 7 days', value: String(detail.importStats.last7dCalls) },
                  { label: 'Last 24 hours', value: String(detail.importStats.last24hCalls) },
                  { label: 'Most recent call', value: formatDateTime(detail.importStats.lastCallAt) },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2"
                  >
                    <dt className="text-[11px] uppercase tracking-wide text-neutral-500">
                      {s.label}
                    </dt>
                    <dd className="mt-0.5 font-mono text-sm tabular-nums text-neutral-900">
                      {s.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          {provider === 'aircall' ? (
            <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                Background jobs (Inngest)
              </h2>
              <p className="mt-1 max-w-xl text-xs text-neutral-500">
                Importing runs as background jobs through Inngest. If this is not
                connected, the “Test connection” above can still pass (it’s a
                direct call) while backfills stay pending and nothing imports.
              </p>

              <div className={`mt-3 rounded-lg border px-3 py-2.5 text-sm ${bjTone[bjStatus.tone]}`}>
                <div className="font-semibold">{bjStatus.title}</div>
                <p className="mt-0.5 text-xs leading-relaxed">{bjStatus.body}</p>
              </div>

              {bj.stuckBackfills > 0 ? (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {bj.stuckBackfills} backfill
                  {bj.stuckBackfills === 1 ? '' : 's'} stuck on{' '}
                  <span className="font-mono">pending</span> for over 3 minutes —
                  the worker is not picking jobs up. Connect Inngest (above), then
                  cancel the stuck job{bj.stuckBackfills === 1 ? '' : 's'} and start
                  a fresh backfill.
                </div>
              ) : null}

              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
                  <dt className="text-[11px] uppercase tracking-wide text-neutral-500">
                    INNGEST_EVENT_KEY
                  </dt>
                  <dd className="mt-1">
                    {bj.inngestEventKeySet ? (
                      <Badge tone="success">set</Badge>
                    ) : (
                      <Badge tone="danger">missing</Badge>
                    )}
                  </dd>
                </div>
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
                  <dt className="text-[11px] uppercase tracking-wide text-neutral-500">
                    INNGEST_SIGNING_KEY
                  </dt>
                  <dd className="mt-1">
                    {bj.inngestSigningKeySet ? (
                      <Badge tone="success">set</Badge>
                    ) : (
                      <Badge tone="danger">missing</Badge>
                    )}
                  </dd>
                </div>
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
                  <dt className="text-[11px] uppercase tracking-wide text-neutral-500">
                    Last cron run
                  </dt>
                  <dd className="mt-1 font-mono text-xs tabular-nums text-neutral-900">
                    {formatDateTime(bj.lastCronRunAt)}
                    {bj.lastCronFunctionId ? (
                      <span className="block text-[10px] text-neutral-500">
                        {bj.lastCronFunctionId}
                      </span>
                    ) : null}
                  </dd>
                </div>
              </dl>
            </section>
          ) : null}

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
                    className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card"
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
            <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                  Per-agent connections
                </h2>
                {provider === 'trengo' ? (
                  <Link
                    href="/account/trengo/connect"
                    className="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700"
                  >
                    Connect your Trengo API token →
                  </Link>
                ) : provider === 'gmail' ? (
                  <Link
                    href="/settings/email-accounts"
                    className="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700"
                  >
                    Connect a mailbox →
                  </Link>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                {provider === 'trengo'
                  ? 'Trengo uses a per-agent API token so outbound messages keep each agent’s identity. Each agent connects their own token (rotates every 90 days).'
                  : detail.perAgent.length === 0
                    ? `No agents have connected ${detail.label} yet.`
                    : `${detail.perAgent.length} agent${detail.perAgent.length === 1 ? '' : 's'} connected.`}
              </p>
              {detail.perAgent.length > 0 ? (
                <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
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
              <p className="mt-3 rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-600 shadow-card">
                No events received from {detail.label} yet. Use the{' '}
                <strong>Test webhook</strong> button above to insert a
                synthetic event and confirm the persistence path is healthy.
              </p>
            ) : (
              <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
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
              <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
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

          {isBackfillable ? (
            <section>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                  Backfill history
                </h2>
                {showBackfillButton ? (
                  <BackfillButton provider={provider as 'aircall' | 'slack'} />
                ) : provider === 'trengo' && canTest ? (
                  <TrengoImportButton />
                ) : null}
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                {SHARED_TOKEN_BACKFILL.has(provider)
                  ? 'Pulls the last 90 days of history and creates retroactive timeline entries for matched contacts.'
                  : provider === 'trengo'
                    ? 'A 90-day import runs automatically on first connect (matched contacts only). “Import last 8 months” pulls a longer window and creates a Contact for each unknown sender, tagged “Trengo import” so the batch stays reviewable.'
                    : 'A 90-day historic import runs automatically the first time an agent connects.'}
              </p>
              {backfillRuns.length === 0 ? (
                <p className="mt-3 rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-600 shadow-card">
                  No backfill has run for {detail.label} yet.
                </p>
              ) : (
                <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>Started</Th>
                        <Th>Status</Th>
                        <Th>Processed</Th>
                        <Th>Matched</Th>
                        <Th>Skipped</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {backfillRuns.map((b) => (
                        <Tr key={b.id}>
                          <Td className="font-mono text-xs tabular-nums">
                            {formatDateTime(b.startedAt ?? b.createdAt)}
                          </Td>
                          <Td>
                            {b.status === 'completed' ? (
                              <Badge tone="success">completed</Badge>
                            ) : b.status === 'failed' ? (
                              <Badge tone="danger">failed</Badge>
                            ) : b.status === 'running' ? (
                              <Badge tone="warn">running</Badge>
                            ) : (
                              <Badge tone="neutral">{b.status}</Badge>
                            )}
                          </Td>
                          <Td className="font-mono text-xs tabular-nums">
                            {b.processedCount}
                          </Td>
                          <Td className="font-mono text-xs tabular-nums">
                            {b.matchedCount}
                          </Td>
                          <Td className="font-mono text-xs tabular-nums">
                            {b.skippedCount}
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </div>
              )}
            </section>
          ) : null}
        </div>
      </PageBody>
    </>
  )
}
