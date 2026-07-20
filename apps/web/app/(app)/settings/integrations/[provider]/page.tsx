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
import { Card } from '@/components/ui/card'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { IntegrationTestButton } from '../IntegrationTestButton'

import { AircallProbeButton } from './AircallProbeButton'
import { BackfillButton } from './BackfillButton'
import { CancelBackfillButton } from './CancelBackfillButton'
import { SlackProbeButton } from './SlackProbeButton'
import { TrengoImportButton } from './TrengoImportButton'
import { TrengoProbeButton } from './TrengoProbeButton'
import { LeadIngestionPanel } from './LeadIngestionPanel'
import { LeadMaintenanceButton } from './LeadMaintenanceButton'

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
          {provider === 'lead' ? (
            <>
              <div className="flex justify-end">
                <LeadMaintenanceButton />
              </div>
              <LeadIngestionPanel />
            </>
          ) : null}

          {provider === 'aircall' && detail.importStats ? (
            <Card className="p-4">
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
            </Card>
          ) : null}

          {provider === 'slack' && detail.slackStats ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                Slack mention health
              </h2>
              <p className="mt-1 max-w-2xl text-xs text-neutral-500">
                When a customer’s name, phone, or email is posted in a watched
                Slack channel, it should appear on their contact page. This
                shows where the pipeline is: <strong>Events received</strong> is
                Slack actually delivering to us (needs the bot in the channel{' '}
                <em>and</em> Event Subscriptions pointing at{' '}
                <code className="font-mono">/api/webhooks/slack</code> with{' '}
                <code className="font-mono">SLACK_SIGNING_SECRET</code> set). If
                that’s 0, it’s a Slack-app setup issue, not matching.{' '}
                <strong>Linked to a contact</strong> are mentions saved on a
                customer; <strong>Awaiting triage</strong> arrived but couldn’t
                be auto-matched — work them at{' '}
                <Link href="/inbox/slack-mentions" className="text-primary-700 hover:underline">
                  Slack mentions
                </Link>
                .
              </p>
              <div
                className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                  detail.slackStats.eventsReceived === 0
                    ? 'border-red-200 bg-red-50 text-red-900'
                    : detail.slackStats.mentionsLinked === 0 &&
                        detail.slackStats.parkedForTriage === 0
                      ? 'border-amber-200 bg-amber-50 text-amber-900'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-900'
                }`}
              >
                {detail.slackStats.eventsReceived === 0
                  ? 'No Slack WEBHOOK events have reached the CRM (this counter only tracks the Events API push, not the 15-min pull). The pull sync still works from SLACK_BOT_TOKEN alone — use “Test Slack connection” below to see which channels the bot can actually read, then “Sync from Slack now”. For real-time push too, point the Slack app’s Event Subscriptions at /api/webhooks/slack (subscribe message.channels) with SLACK_SIGNING_SECRET set.'
                  : detail.slackStats.mentionsLinked === 0 && detail.slackStats.parkedForTriage === 0
                    ? 'Events are arriving but none matched a contact yet — most messages are noise (no name/phone/email). Post a message with a customer’s phone or email and re-check, or run the backfill below to reprocess history through the matcher.'
                    : 'Connected — Slack mentions are being captured and matched to contacts.'}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {[
                  { label: 'Events received', value: String(detail.slackStats.eventsReceived) },
                  { label: 'Last 7 days', value: String(detail.slackStats.last7dEvents) },
                  {
                    label: 'Most recent event',
                    value: formatDateTime(detail.slackStats.lastEventAt),
                  },
                  { label: 'Linked to a contact', value: String(detail.slackStats.mentionsLinked) },
                  { label: 'Awaiting triage', value: String(detail.slackStats.parkedForTriage) },
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
              {canTest ? (
                <div className="mt-4 flex justify-end border-t border-neutral-100 pt-3">
                  <SlackProbeButton />
                </div>
              ) : null}
            </Card>
          ) : null}

          {provider === 'trengo' && detail.trengoStats ? (
            <Card className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                    Message import health
                  </h2>
                  <p className="mt-1 max-w-xl text-xs text-neutral-500">
                    Messages mirrored from Trengo (live webhooks + history
                    imports). If everything reads 0, run an import below and
                    check the result in the history table; if new messages
                    never appear, the Trengo webhook must point at{' '}
                    <code className="font-mono">/api/webhooks/trengo</code> with
                    the secret set. Use “Test Trengo connection” to check your
                    API token directly.
                  </p>
                </div>
                {canTest ? <TrengoProbeButton /> : null}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  {
                    label: 'Messages in CRM',
                    value: String(detail.trengoStats.totalMessages),
                  },
                  {
                    label: 'Last 7 days',
                    value: String(detail.trengoStats.last7dMessages),
                  },
                  {
                    label: 'Last 24 hours',
                    value: String(detail.trengoStats.last24hMessages),
                  },
                  {
                    label: 'Most recent message',
                    value: formatDateTime(detail.trengoStats.lastMessageAt),
                  },
                  {
                    label: 'Conversations (comms centre)',
                    value: String(detail.trengoStats.conversationHeads),
                  },
                  {
                    label: 'Contacts from import',
                    value: String(detail.trengoStats.contactsFromImport),
                  },
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
            </Card>
          ) : null}

          {isBackfillable ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                Background jobs (Inngest)
              </h2>
              <p className="mt-1 max-w-xl text-xs text-neutral-500">
                Importing runs as background jobs through Inngest. If this is not
                connected, the “Test connection” / token check can still pass
                (it’s a direct call) while backfills stay pending and nothing
                imports.
              </p>

              <div className={`mt-3 rounded-lg border px-3 py-2.5 text-sm ${bjTone[bjStatus.tone]}`}>
                <div className="font-semibold">{bjStatus.title}</div>
                <p className="mt-0.5 text-xs leading-relaxed">{bjStatus.body}</p>
              </div>

              {bj.stuckBackfills > 0 ? (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {bj.stuckBackfills} backfill
                  {bj.stuckBackfills === 1 ? '' : 's'} stalled (no progress for
                  over 15 minutes) — the worker restarted mid-run or isn’t
                  picking jobs up. Use <span className="font-medium">Cancel</span>{' '}
                  in the history below, or just start a fresh import: a stalled
                  run is now auto-superseded. If imports keep stalling, connect
                  Inngest (above).
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
            </Card>
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
            <Card className="mt-3 overflow-hidden">
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
            </Card>
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
                <Card className="mt-3 overflow-hidden">
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
                </Card>
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
              <Card className="mt-3 overflow-hidden">
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
              </Card>
            )}
          </section>

          {detail.recentCronRuns.length > 0 ? (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                Recent cron runs
              </h2>
              <Card className="mt-3 overflow-hidden">
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
              </Card>
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
                    ? 'A 90-day import runs automatically on first connect (matched contacts only). “Import history” pulls a selectable window — up to everything (5 years) — and creates a Contact for each unknown sender, tagged “Trengo import” so the batch stays reviewable. Imported conversations land in the comms centre, the inbox, and each contact’s timeline.'
                    : 'A 90-day historic import runs automatically the first time an agent connects.'}
              </p>
              {backfillRuns.length === 0 ? (
                <p className="mt-3 rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-600 shadow-card">
                  No backfill has run for {detail.label} yet.
                </p>
              ) : (
                <Card className="mt-3 overflow-hidden">
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>Started</Th>
                        <Th>Status</Th>
                        <Th>Processed</Th>
                        <Th>Matched</Th>
                        <Th>Skipped</Th>
                        {canTest ? <Th>Action</Th> : null}
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
                            {b.status === 'failed' && b.error ? (
                              <p className="mt-1 max-w-xs text-[11px] leading-snug text-red-700">
                                {b.error}
                              </p>
                            ) : null}
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
                          {canTest ? (
                            <Td>
                              {b.status === 'pending' || b.status === 'running' ? (
                                <CancelBackfillButton jobId={b.id} />
                              ) : null}
                            </Td>
                          ) : null}
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </Card>
              )}
            </section>
          ) : null}
        </div>
      </PageBody>
    </>
  )
}
