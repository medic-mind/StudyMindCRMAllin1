// Admin → Integrations status + detail. Read-only summary for Settings
// dashboard plus a per-provider detail surface that surfaces required env
// vars (presence only — never the value), recent ProviderEvent rows, recent
// CronRun rows for the provider's refresh job(s), and per-agent connection
// state where applicable (Gmail, Trengo).
//
// Role gating (ADR 0014):
//   - status / detail: ceo | senior_manager | manager (read-only)
//   - test:            ceo | senior_manager (writes a synthetic event)
//
// CLAUDE.md §11, §13, §14, §17.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { STALE_BACKFILL_MS } from '@studymind/core/backfill'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

const READ_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

const TEST_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
])

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

export type Provider = (typeof PROVIDERS)[number]

// Grouping for the Integrations index so the catalog reads by purpose rather
// than as one flat grid (UI organising only — no behaviour change).
const PROVIDER_CATEGORY: Record<Provider, string> = {
  stripe: 'Payments & finance',
  gocardless: 'Payments & finance',
  aircall: 'Communications',
  trengo: 'Communications',
  slack: 'Communications',
  gmail: 'Communications',
  asana: 'Productivity',
  booking: 'Booking & data',
  lead: 'Lead capture',
}

interface ProviderConfig {
  /** Human-readable label for the UI. */
  label: string
  /** One-line description used on the index grid card. */
  description: string
  /** Environment variables that must be set for the integration to work. */
  envVars: ReadonlyArray<string>
  /** Inngest function ids for refresh / housekeeping jobs (CronRun.functionId). */
  cronFunctionIds: ReadonlyArray<string>
  /** Per-agent token model name (`gmail` / `trengo` only) or null. */
  perAgentTokens: 'gmail' | 'trengo' | null
  /** Runbook path for secret rotation / connection setup. */
  runbook: string
  /** Ordered setup checklist for not_configured providers. */
  setupSteps: ReadonlyArray<{ title: string; body: string }>
  /** Link to the provider's own dashboard for webhooks / API keys. */
  providerDashboardUrl: string | null
}

// Catalog of every integration the CRM speaks to. Update this when a new
// provider is wired in — the index page reads from PROVIDERS and the detail
// page reads from PROVIDER_CONFIG. Keeping both in this one file makes the
// "add an integration" change a single-PR diff.
const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
  stripe: {
    label: 'Stripe',
    description:
      'Subscriptions, one-off charges, refunds, payment links. CLAUDE.md §8.',
    envVars: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'],
    cronFunctionIds: [],
    perAgentTokens: null,
    runbook: '/docs/runbooks/secret-rotation.md',
    setupSteps: [
      {
        title: 'Create the webhook endpoint',
        body: 'In the Stripe dashboard → Developers → Webhooks → Add endpoint, point at https://<your-host>/api/webhooks/stripe and subscribe to invoice.*, customer.subscription.*, charge.*, checkout.session.completed.',
      },
      {
        title: 'Copy the signing secret',
        body: 'Copy the whsec_ value into STRIPE_WEBHOOK_SECRET in Railway.',
      },
      {
        title: 'Add the API keys',
        body: 'Settings → Developers → API keys. Paste the secret key into STRIPE_SECRET_KEY and the publishable key into STRIPE_PUBLISHABLE_KEY.',
      },
    ],
    providerDashboardUrl: 'https://dashboard.stripe.com/webhooks',
  },
  gocardless: {
    label: 'GoCardless',
    description: 'Bacs Direct Debit, late-failure reversals. CLAUDE.md §9.',
    envVars: [
      'GOCARDLESS_ACCESS_TOKEN',
      'GOCARDLESS_WEBHOOK_SECRET',
      'GOCARDLESS_ENVIRONMENT',
    ],
    cronFunctionIds: ['gocardless/reconcile-late-failures'],
    perAgentTokens: null,
    runbook: '/docs/runbooks/secret-rotation.md',
    setupSteps: [
      {
        title: 'Generate an access token',
        body: 'GoCardless dashboard → Developers → Access tokens. Use a sandbox token in non-prod environments.',
      },
      {
        title: 'Register the webhook',
        body: 'Developers → Webhook endpoints → Add. URL is https://<your-host>/api/webhooks/gocardless. Set the secret into GOCARDLESS_WEBHOOK_SECRET.',
      },
    ],
    providerDashboardUrl: 'https://manage.gocardless.com/developers/webhook-endpoints',
  },
  aircall: {
    label: 'Aircall',
    description: 'Inbound/outbound calls, voicemail, AI Assist transcripts. CLAUDE.md §10.',
    envVars: ['AIRCALL_API_ID', 'AIRCALL_API_TOKEN', 'AIRCALL_WEBHOOK_TOKEN'],
    cronFunctionIds: ['aircall/sync-calls', 'aircall/recover-disabled-webhook'],
    perAgentTokens: null,
    runbook: '/docs/runbooks/aircall-webhook-disabled.md',
    setupSteps: [
      {
        title: 'Create an API integration',
        body: 'Aircall dashboard → Integrations & API → API Keys → Add. Save the ID and token into AIRCALL_API_ID / AIRCALL_API_TOKEN.',
      },
      {
        title: 'Subscribe to webhook events',
        body: 'Integrations → Webhooks. Point at https://<your-host>/api/webhooks/aircall and subscribe to call.created, call.ringing_on_agent, call.answered, call.hungup, call.ended, call.voicemail_left, call.tagged, call.commented.',
      },
    ],
    providerDashboardUrl: 'https://dashboard.aircall.io',
  },
  trengo: {
    label: 'Trengo',
    description: 'WhatsApp, SMS, email, web chat. Per-agent tokens. CLAUDE.md §11.',
    envVars: ['TRENGO_API_BASE_URL', 'TRENGO_WEBHOOK_SECRET'],
    cronFunctionIds: [],
    perAgentTokens: 'trengo',
    runbook: '/docs/runbooks/secret-rotation.md',
    setupSteps: [
      {
        title: 'Each agent connects their own token',
        body: 'Outbound messages preserve agent identity, so every agent must create a personal Trengo API token from Settings → API and paste it into Account → Trengo inside the CRM. Tokens rotate every 90 days; the CRM banners 14 days before expiry.',
      },
      {
        title: 'Register the inbound webhook',
        body: 'Trengo Settings → Webhooks → Add. URL is https://<your-host>/api/webhooks/trengo. Save the secret into TRENGO_WEBHOOK_SECRET.',
      },
    ],
    providerDashboardUrl: 'https://app.trengo.com/admin/api',
  },
  slack: {
    label: 'Slack',
    description: 'Channel summaries (one-way today). CLAUDE.md §12.',
    envVars: ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN'],
    cronFunctionIds: [],
    perAgentTokens: null,
    runbook: '/docs/runbooks/secret-rotation.md',
    setupSteps: [
      {
        title: 'Create the Slack app',
        body: 'api.slack.com/apps → Create New App. Add Bot Token Scopes channels:history, channels:read and chat:write (channels:read powers the pick-by-name channel browser in Settings → Slack channels). Install to workspace and copy the bot token into SLACK_BOT_TOKEN.',
      },
      {
        title: 'Subscribe to events',
        body: 'Event Subscriptions → Request URL is https://<your-host>/api/webhooks/slack. Subscribe message.channels. Copy the signing secret into SLACK_SIGNING_SECRET.',
      },
    ],
    providerDashboardUrl: 'https://api.slack.com/apps',
  },
  asana: {
    label: 'Asana',
    description: 'Project-scoped task sync. CLAUDE.md §13.',
    envVars: ['ASANA_PERSONAL_ACCESS_TOKEN', 'ASANA_WEBHOOK_SECRET'],
    cronFunctionIds: [],
    perAgentTokens: null,
    runbook: '/docs/runbooks/secret-rotation.md',
    setupSteps: [
      {
        title: 'Create a Personal Access Token',
        body: 'Asana → My Settings → Apps → Manage Developer Apps → + New access token. Paste into ASANA_PERSONAL_ACCESS_TOKEN.',
      },
      {
        title: 'Register the project webhook',
        body: 'Webhooks register programmatically against the project allowlist in packages/integrations/asana/config.ts. The handshake echoes X-Hook-Secret automatically on first registration.',
      },
    ],
    providerDashboardUrl: 'https://app.asana.com/0/my-apps',
  },
  gmail: {
    label: 'Gmail',
    description: 'Per-agent OAuth + Pub/Sub watch. CLAUDE.md §14.',
    envVars: [
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GMAIL_PUBSUB_TOPIC',
      'NEXT_PUBLIC_APP_URL',
    ],
    cronFunctionIds: ['gmail/refresh-watch'],
    perAgentTokens: 'gmail',
    runbook: '/docs/runbooks/secret-rotation.md',
    setupSteps: [
      {
        title: 'Create the OAuth client',
        body: 'Google Cloud Console → APIs & Services → Credentials → + Create Credentials → OAuth client ID. Authorised redirect URI is https://<your-host>/api/oauth/gmail/callback. Save the client id and secret into GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.',
      },
      {
        title: 'Create the Pub/Sub topic',
        body: 'gcloud pubsub topics create gmail-watch; gcloud pubsub subscriptions create gmail-watch-sub --topic gmail-watch --push-endpoint=https://<your-host>/api/webhooks/gmail. Save the topic name into GMAIL_PUBSUB_TOPIC.',
      },
      {
        title: 'Each agent connects their mailbox',
        body: 'Account → Mailbox in the CRM. Watches expire after 7 days and are renewed every 6 days by the gmail/refresh-watch cron.',
      },
    ],
    providerDashboardUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  booking: {
    label: 'Booking site',
    description: 'Pull-based sync from booking.studymind.co.uk. CLAUDE.md §15.',
    envVars: ['BOOKING_API_BASE_URL', 'BOOKING_API_TOKEN'],
    cronFunctionIds: [
      'booking/sync-students',
      'booking/sync-lessons',
      'booking/sync-balance-ledger',
      'booking/sync-credit-ledger',
    ],
    perAgentTokens: null,
    runbook: '/docs/runbooks/secret-rotation.md',
    setupSteps: [
      {
        title: 'Request a service-account token',
        body: 'Ask the booking-site team for a service-account API token with read access to families, bookings, and sessions. Paste into BOOKING_API_TOKEN.',
      },
      {
        title: 'Confirm the base URL',
        body: 'The default is https://booking.studymind.co.uk/api. Override BOOKING_API_BASE_URL only when pointing at staging.',
      },
    ],
    providerDashboardUrl: null,
  },
  lead: {
    label: 'Lead webhook',
    description:
      'Universal lead capture — Contact Form 7, Zapier, JSON. Auto-classified + routed (ADR 0023). CLAUDE.md §16.',
    // The global fallback token (per-site API keys are managed in the panel
    // below and stored hashed in the DB, so they are not env vars).
    envVars: ['LEAD_WEBHOOK_BEARER_TOKEN'],
    cronFunctionIds: [],
    perAgentTokens: null,
    runbook: '/docs/runbooks/secret-rotation.md',
    setupSteps: [
      {
        title: 'Create a site API key',
        body: 'Use the “Site API keys” panel on this page to mint a key per website. The raw key is shown once; store it in 1Password and the form’s webhook config.',
      },
      {
        title: 'Paste the webhook URL into Contact Form 7',
        body: 'URL is https://<your-host>/api/leads. Send the key as an Authorization: Bearer header, an X-API-Key header, or a ?key= query param. Any field layout works — see docs/api/leads-endpoint.md.',
      },
      {
        title: '(Optional) global fallback token',
        body: 'Set LEAD_WEBHOOK_BEARER_TOKEN in Railway for a zero-config master key (also used by the legacy /api/webhooks/lead Zapier endpoint).',
      },
    ],
    providerDashboardUrl: null,
  },
}

type ConnectionStatus = 'connected' | 'needs_attention' | 'not_configured'

function deriveConnectionStatus(args: {
  envVarsAllSet: boolean
  lastReceivedAt: Date | null
  perAgentConnectedCount: number | null
  perAgentExpiredCount: number | null
}): ConnectionStatus {
  if (!args.envVarsAllSet) return 'not_configured'
  if (args.perAgentExpiredCount !== null && args.perAgentExpiredCount > 0) {
    return 'needs_attention'
  }
  if (
    args.perAgentConnectedCount !== null &&
    args.perAgentConnectedCount === 0
  ) {
    // Provider is configured but no agent has connected yet (Gmail/Trengo).
    return 'needs_attention'
  }
  // For webhook-only providers, "no event received in 30 days" is not by
  // itself an error (sandbox accounts, quiet integrations). The dashboard
  // surfaces recency separately; the status stays `connected` once env is set.
  return 'connected'
}

export const adminIntegrationsRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    if (!READ_ROLES.has(user.role)) {
      throw new TRPCError({ code: 'FORBIDDEN' })
    }

    // Last received ProviderEvent per provider.
    const lastEvents = await Promise.all(
      PROVIDERS.map(async (provider) => {
        const row = await ctx.db.providerEvent.findFirst({
          where: { provider },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true, type: true, eventId: true },
        })
        return { provider, last: row }
      }),
    )

    // Gmail per-agent watch expiry (CLAUDE.md §14, §17.1).
    const gmailMailboxes = await ctx.db.gmailMailbox.findMany({
      where: { deletedAt: null },
      select: { agentId: true, address: true, watchExpiresAt: true },
      take: 25,
      orderBy: { watchExpiresAt: 'asc' },
    })
    const now = Date.now()
    const gmailExpiringSoon = gmailMailboxes.filter(
      (m) => m.watchExpiresAt !== null && m.watchExpiresAt.getTime() - now < 1000 * 60 * 60 * 24,
    ).length

    // Asana webhooks registered (one per project).
    const asanaWebhookCount = await ctx.db.asanaWebhook.count()

    return {
      providers: lastEvents.map((p) => ({
        provider: p.provider,
        label: PROVIDER_CONFIG[p.provider].label,
        category: PROVIDER_CATEGORY[p.provider],
        description: PROVIDER_CONFIG[p.provider].description,
        lastReceivedAt: p.last?.receivedAt ?? null,
        lastEventType: p.last?.type ?? null,
        lastEventId: p.last?.eventId ?? null,
        envVarsAllSet: PROVIDER_CONFIG[p.provider].envVars.every(
          (name) => Boolean(process.env[name]),
        ),
      })),
      gmail: {
        connectedAgents: gmailMailboxes.length,
        expiringSoon: gmailExpiringSoon,
        mailboxes: gmailMailboxes.map((m) => ({
          agentId: m.agentId,
          address: m.address,
          watchExpiresAt: m.watchExpiresAt,
        })),
      },
      asana: {
        webhooks: asanaWebhookCount,
      },
    }
  }),

  /**
   * Per-provider detail. Returns env-var presence (never values), the most
   * recent ProviderEvent rows, the most recent CronRun rows for the
   * provider's refresh jobs, and per-agent connection state where the
   * provider has per-agent tokens (Gmail, Trengo). Read-only and gated to
   * ceo | senior_manager | manager.
   */
  detail: protectedProcedure
    .input(z.object({ provider: z.enum(PROVIDERS) }))
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!READ_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }

      const cfg = PROVIDER_CONFIG[input.provider]
      const envVars = cfg.envVars.map((name) => ({
        name,
        isSet: Boolean(process.env[name]),
      }))
      const envVarsAllSet = envVars.every((v) => v.isSet)

      // Last few received events for this provider.
      const recentEvents = await ctx.db.providerEvent.findMany({
        where: { provider: input.provider },
        orderBy: { receivedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          eventId: true,
          type: true,
          receivedAt: true,
        },
      })

      // Last cron runs for the provider's refresh / housekeeping jobs.
      const recentCronRuns = cfg.cronFunctionIds.length
        ? await ctx.db.cronRun.findMany({
            where: { functionId: { in: [...cfg.cronFunctionIds] } },
            orderBy: { finishedAt: 'desc' },
            take: 10,
            select: {
              id: true,
              functionId: true,
              success: true,
              durationMs: true,
              finishedAt: true,
              errorCode: true,
            },
          })
        : []

      // Per-agent connection state (Gmail / Trengo). For other providers
      // this is null and the UI omits the section.
      let perAgent: Array<{
        agentId: string
        label: string
        expiresAt: Date | null
        expired: boolean
        expiringSoon: boolean
      }> | null = null
      const oneDayMs = 1000 * 60 * 60 * 24
      const nowMs = Date.now()
      if (cfg.perAgentTokens === 'gmail') {
        const rows = await ctx.db.gmailMailbox.findMany({
          where: { deletedAt: null },
          select: { agentId: true, address: true, watchExpiresAt: true },
          orderBy: { watchExpiresAt: 'asc' },
          take: 50,
        })
        perAgent = rows.map((r) => {
          const expiresMs = r.watchExpiresAt?.getTime() ?? null
          return {
            agentId: r.agentId,
            label: r.address,
            expiresAt: r.watchExpiresAt,
            expired: expiresMs !== null && expiresMs <= nowMs,
            expiringSoon:
              expiresMs !== null && expiresMs > nowMs && expiresMs - nowMs < oneDayMs,
          }
        })
      } else if (cfg.perAgentTokens === 'trengo') {
        const rows = await ctx.db.trengoToken.findMany({
          where: { deletedAt: null },
          select: { agentId: true, expiresAt: true },
          orderBy: { expiresAt: 'asc' },
          take: 50,
        })
        // Resolve email labels for the agent ids.
        const users = await ctx.db.user.findMany({
          where: { id: { in: rows.map((r) => r.agentId) } },
          select: { id: true, email: true },
        })
        const emailById = new Map(users.map((u) => [u.id, u.email]))
        perAgent = rows.map((r) => {
          const expiresMs = r.expiresAt.getTime()
          return {
            agentId: r.agentId,
            label: emailById.get(r.agentId) ?? r.agentId,
            expiresAt: r.expiresAt,
            expired: expiresMs <= nowMs,
            expiringSoon:
              expiresMs > nowMs && expiresMs - nowMs < 14 * oneDayMs,
          }
        })
      }

      const expiredCount = perAgent?.filter((a) => a.expired).length ?? null

      // Aircall: how many calls have actually landed in our mirror, so the
      // operator can see at a glance whether import is working (CLAUDE.md §10).
      let importStats: {
        totalCalls: number
        last7dCalls: number
        last24hCalls: number
        lastCallAt: Date | null
      } | null = null
      if (input.provider === 'aircall') {
        const sevenDaysAgo = new Date(nowMs - 7 * oneDayMs)
        const oneDayAgo = new Date(nowMs - oneDayMs)
        const [totalCalls, last7dCalls, last24hCalls, lastCall] = await Promise.all([
          ctx.db.interaction.count({ where: { type: 'call' } }),
          ctx.db.interaction.count({ where: { type: 'call', occurredAt: { gte: sevenDaysAgo } } }),
          ctx.db.interaction.count({ where: { type: 'call', occurredAt: { gte: oneDayAgo } } }),
          ctx.db.interaction.findFirst({
            where: { type: 'call' },
            orderBy: { occurredAt: 'desc' },
            select: { occurredAt: true },
          }),
        ])
        importStats = {
          totalCalls,
          last7dCalls,
          last24hCalls,
          lastCallAt: lastCall?.occurredAt ?? null,
        }
      }

      // Background-job (Inngest) health — Inngest is the engine that runs every
      // import job (backfill, the 10-min sync, webhook processing). A backfill
      // stuck `pending` past a few minutes means the worker isn't picking jobs
      // up, which usually means Inngest isn't connected/synced. CLAUDE.md §17.
      // A pending OR running job whose progress has not advanced for the shared
      // stale window is orphaned (the worker restarted mid-run or never picked
      // it up). Counting `running` too — not just `pending` — is what surfaces
      // the "Importing 0 items…" jobs that otherwise sit invisible.
      const [lastCronRun, stuckBackfills] = await Promise.all([
        ctx.db.cronRun.findFirst({
          orderBy: { finishedAt: 'desc' },
          select: { finishedAt: true, functionId: true, success: true },
        }),
        ctx.db.backfillJob.count({
          where: {
            status: { in: ['pending', 'running'] },
            updatedAt: { lt: new Date(nowMs - STALE_BACKFILL_MS) },
          },
        }),
      ])
      const backgroundJobs = {
        inngestEventKeySet: Boolean(process.env['INNGEST_EVENT_KEY']),
        inngestSigningKeySet: Boolean(process.env['INNGEST_SIGNING_KEY']),
        lastCronRunAt: lastCronRun?.finishedAt ?? null,
        lastCronFunctionId: lastCronRun?.functionId ?? null,
        stuckBackfills,
      }

      const status = deriveConnectionStatus({
        envVarsAllSet,
        lastReceivedAt: recentEvents[0]?.receivedAt ?? null,
        perAgentConnectedCount: perAgent?.length ?? null,
        perAgentExpiredCount: expiredCount,
      })

      return {
        provider: input.provider,
        label: cfg.label,
        description: cfg.description,
        status,
        envVars,
        envVarsAllSet,
        runbook: cfg.runbook,
        providerDashboardUrl: cfg.providerDashboardUrl,
        recentEvents,
        recentCronRuns,
        perAgent,
        importStats,
        backgroundJobs,
        setupSteps: cfg.setupSteps,
      }
    }),

  /**
   * Live Aircall connectivity probe (CEO / Senior Manager). Unlike `test`
   * (which only proves our own persistence path), this actually calls the
   * Aircall REST API with the configured AIRCALL_API_ID / AIRCALL_API_TOKEN
   * and reports whether the keys work and how many calls Aircall can see — so
   * "nothing is importing" can be pinned to keys, webhook, or an empty account.
   * Read-only against Aircall; audited.
   */
  probeAircall: auditedProcedure.mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    if (!TEST_ROLES.has(user.role)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'admin only' })
    }
    const result = await (async (): Promise<
      | { ok: true; totalCallsVisible: number | null; mostRecentCallAt: Date | null }
      | { ok: false; error: string }
    > => {
      try {
        const { createClient } = await import('@studymind/integration-aircall/client')
        const client = createClient() // throws if API_ID / API_TOKEN are unset
        const res = await client.request<{
          calls?: Array<{ started_at?: number }>
          meta?: { total?: number }
        }>('GET', '/calls?per_page=1&order=desc')
        const recent = res.calls?.[0]
        return {
          ok: true,
          totalCallsVisible: res.meta?.total ?? null,
          mostRecentCallAt:
            recent?.started_at != null ? new Date(recent.started_at * 1000) : null,
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
      }
    })()
    await ctx.audit({
      action: 'admin.integration_tested',
      target: { type: 'Integration', id: 'aircall' },
      after: { probe: 'aircall_api_live', ok: result.ok },
    })
    return result
  }),

  /**
   * Synthetic ping that proves the ProviderEvent persistence path is
   * healthy end-to-end. CEO / Senior Manager only and audited. Does NOT
   * call the live provider API or forge a signature — instead it inserts
   * a sentinel ProviderEvent row of type `test.synthetic` so the
   * dashboard's "last received" timestamp updates and the row appears in
   * audit logs.
   */
  test: auditedProcedure
    .input(z.object({ provider: z.enum(PROVIDERS) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!TEST_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'admin only' })
      }
      const eventId = `synthetic-${createId()}`
      const row = await ctx.db.providerEvent.create({
        data: {
          id: createId(),
          provider: input.provider,
          eventId,
          type: 'test.synthetic',
          raw: { source: 'admin.integrations.test', actorId: user.id } as object,
          receivedAt: new Date(),
        },
      })
      await ctx.audit({
        action: 'admin.integration_tested',
        target: { type: 'ProviderEvent', id: row.id },
        after: { provider: input.provider, eventId },
      })
      return { provider: input.provider, eventId }
    }),
})
