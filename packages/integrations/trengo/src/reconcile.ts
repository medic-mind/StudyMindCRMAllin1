// Trengo status reconcile cron (ADR 0020). CLAUDE.md §4, §15, §17.
//
// Webhooks are the LIVE path, but they are only ever as complete as the
// Trengo webhook *subscription*. If the workspace did not subscribe the
// "ticket closed / reopened / assigned / label" events — or a delivery is
// dropped, or Trengo disabled the endpoint after failures — the Conversation
// head silently drifts from Trengo. That is the reported symptom: "tickets
// still open here that are closed on Trengo".
//
// Golden rule #4 (CLAUDE.md §2): external APIs are the source of truth, not
// our DB; when in doubt, refetch. This cron is the safety net that makes the
// CRM mirror Trengo *continuously* without anyone running a manual import: it
// re-fetches each conversation's CURRENT state from Trengo and re-converges
// the head (status, assignee, labels) through the SAME monotonic merger the
// live webhook uses. Idempotent, audited, and bounded per tick.
//
// Fair round-robin: heads are processed oldest-`lastSyncCheckAt`-first (null
// first), and every checked head's cursor is stamped, so the whole population
// is swept over time and no row is starved.

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { TrengoApiError, createClientForAgent, type TrengoClient } from './client'
import { applyEventToConversation } from './conversation-head'
import {
  type NormalisedTicket,
  type TrengoListEndpoint,
  buildUserNameMap,
  listTicketsPage,
  normaliseTicketRow,
  parseListResponse,
  processTicket,
  ticketWithinWindow,
} from './backfill'

/** Per tick. 120 every 10 min ≈ 17k/day, far more than the open-conversation
 *  population, so every head is rechecked many times a day while staying under
 *  Trengo's 120 req/min limit. The on-demand sync converges the recent set in
 *  one go. */
const BATCH = 120
/** On-demand "Sync now" cap — the most-recently-active OPEN heads (the ones
 *  most likely to have been closed/spam-boxed in Trengo) converged in one run.
 *  ~500 GETs ≈ 5 min at the rate limit; the cron covers the long tail. */
const SYNC_NOW_CAP = 500
/** Discovery sweep: how many listing pages (50 rows each) each cron tick
 *  scans for tickets Trengo has that we do not. Newest tickets sit on the
 *  first pages, so 2 pages every 10 minutes catches anything a dropped
 *  webhook failed to announce well before staff notice. */
const DISCOVER_PAGES_CRON = 2
/** The staff-triggered "Sync from Trengo" digs deeper in one go. */
const DISCOVER_PAGES_SYNC_NOW = 6
/** Only auto-import discovered tickets newer than this — anything older is
 *  the manual "Import all from Trengo" backfill's job. */
const DISCOVER_WINDOW_DAYS = 30

type RequestFn = <T>(method: string, path: string) => Promise<T>

/** The minimal head shape the planner reasons about. Note: heads cross an
 *  Inngest step boundary (JSON), so `lastMessageAt` arrives as an ISO string
 *  at runtime — normalise before use. */
export interface ReconcileHead {
  id: string
  trengoTicketId: number
  status: 'open' | 'closed' | 'snoozed' | 'archived' | 'spam'
  trengoAssigneeId: number | null
  tags: string[]
  contactId: string | null
  familyId: string | null
  channel: string | null
  trengoChannelId: number | null
  trengoChannelName: string | null
  lastMessageAt: Date | string
}

export interface ReconcilePlan {
  /** Status transition to apply via the event merger, or null. */
  statusEvent: 'ticket.closed' | 'ticket.reopened' | null
  /** Set the head directly to `spam` (Trengo Spam box — not an event). */
  setSpam: boolean
  /** Audit detail when status actually flips; null otherwise. */
  statusChange: { from: string; to: 'closed' | 'open' | 'spam' } | null
  /** Apply a `ticket.assigned` when Trengo's assignee differs from ours. */
  applyAssignee: boolean
  /** Clear our assignee — the ticket was UNASSIGNED in Trengo. Without this
   *  a ticket moved back to Trengo's Unassigned tray keeps showing the old
   *  agent here forever. */
  clearAssignee: boolean
  /** Full label set to write when Trengo's labels differ; null = leave as-is. */
  tags: string[] | null
  /** The SPECIFIC Trengo channel id to stamp, when it differs / is missing. */
  channelId: number | null
}

/**
 * Pure: given our head and Trengo's CURRENT ticket, decide what to converge.
 *
 * Status mirrors Trengo BOTH directions:
 *  - Trengo closed + head not closed → close (a `snoozed` head also closes:
 *    snooze is a CRM-only deferral, but if the underlying ticket is closed in
 *    Trengo, closed is the truth).
 *  - Trengo open + head closed → reopen. We do NOT touch a `snoozed` head
 *    here — snooze is a local "open" variant the agent chose deliberately.
 *
 * Assignee mirrors Trengo's current assignee when set and different.
 * Labels are a FULL set sync (a label removed in Trengo disappears here too),
 * only when the ticket payload actually carried a labels/tags key.
 */
export function planReconcile(
  head: ReconcileHead,
  ticket: NormalisedTicket,
): ReconcilePlan {
  let statusEvent: ReconcilePlan['statusEvent'] = null
  let setSpam = false
  let statusChange: ReconcilePlan['statusChange'] = null

  if (ticket.status === 'spam' && head.status !== 'spam') {
    // Trengo Spam box — import it (the head has no spam *event*; set directly).
    setSpam = true
    statusChange = { from: head.status, to: 'spam' }
  } else if (ticket.status === 'closed' && head.status !== 'closed') {
    statusEvent = 'ticket.closed'
    statusChange = { from: head.status, to: 'closed' }
  } else if (
    ticket.status === 'open' &&
    ticket.statusKnown &&
    (head.status === 'closed' || head.status === 'spam')
  ) {
    // Reopen a head Trengo now shows open — whether we had it closed or spam
    // (Trengo un-marked it as spam). Guarded on `statusKnown`: an
    // unrecognised Trengo status folds to 'open' for display but must never
    // reopen a genuinely closed head (§8, fail closed).
    statusEvent = 'ticket.reopened'
    statusChange = { from: head.status, to: 'open' }
  }

  const applyAssignee =
    ticket.assigneeId !== null && ticket.assigneeId !== head.trengoAssigneeId
  const clearAssignee = ticket.assigneeId === null && head.trengoAssigneeId !== null

  const tags =
    ticket.labelsKnown && !sameTagSet(head.tags, ticket.labels)
      ? ticket.labels
      : null

  const channelId =
    ticket.trengoChannelId !== null && ticket.trengoChannelId !== head.trengoChannelId
      ? ticket.trengoChannelId
      : null

  return { statusEvent, setSpam, statusChange, applyAssignee, clearAssignee, tags, channelId }
}

function sameTagSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((t) => set.has(t))
}

/**
 * Fetch one ticket's CURRENT state from Trengo, normalised. Mirrors the
 * backfill's endpoint handling: the documented `/tickets/:id` first, with a
 * one-time fallback to the legacy `/conversations/:id` for older workspaces.
 * `endpoint` pins the choice after the first successful probe.
 *
 * Returns `{ ticket: null, deleted: true }` for a 404 on a *pinned* endpoint
 * (the ticket was deleted in Trengo) — the caller leaves the head untouched
 * (no silent delete, CLAUDE.md §3) and just advances the cursor.
 */
export async function fetchTicketDetail(
  request: RequestFn,
  endpoint: TrengoListEndpoint | null,
  ticketId: number,
): Promise<{ ticket: NormalisedTicket | null; endpoint: TrengoListEndpoint; deleted: boolean }> {
  const tryTickets = endpoint === null || endpoint === 'tickets'
  if (tryTickets) {
    try {
      const res = await request<unknown>('GET', `/tickets/${ticketId}`)
      return { ticket: normaliseDetail(res), endpoint: 'tickets', deleted: false }
    } catch (err) {
      const status = err instanceof TrengoApiError ? err.status : 0
      // 404 on a pinned `tickets` endpoint means the ticket is gone, not that
      // we picked the wrong path.
      if (endpoint === 'tickets' && status === 404) {
        return { ticket: null, endpoint: 'tickets', deleted: true }
      }
      const canFallBack = endpoint === null && (status === 404 || status === 405)
      if (!canFallBack) throw err
      // else: undecided endpoint — fall through to probe `/conversations`.
    }
  }
  try {
    const res = await request<unknown>('GET', `/conversations/${ticketId}`)
    return { ticket: normaliseDetail(res), endpoint: 'conversations', deleted: false }
  } catch (err) {
    if (err instanceof TrengoApiError && err.status === 404) {
      return { ticket: null, endpoint: 'conversations', deleted: true }
    }
    throw err
  }
}

/** Trengo detail responses wrap the row in `{ data: {...} }` on some plans and
 *  return it bare on others. Unwrap then normalise with the shared parser. */
function normaliseDetail(res: unknown): NormalisedTicket | null {
  const root = (res ?? {}) as Record<string, unknown>
  const detail = (root['data'] ?? root) as unknown
  return normaliseTicketRow(detail)
}

// -----------------------------------------------------------------------------
// Discovery — the other half of "mirror Trengo continuously".
//
// Converging heads we already have is not enough: if the webhook subscription
// is broken (secret mismatch, endpoint disabled, event not subscribed) a
// ticket CREATED in Trengo never gets a local head, and no amount of per-head
// re-fetching will ever surface it. That is the reported "I cannot see current
// tickets — it shows outdated ones". So every sweep also walks the first pages
// of Trengo's own ticket listing (newest first), finds ids with no local head,
// and imports them through the same idempotent per-ticket importer the
// backfill uses. Matched senders get the full message history; unknown senders
// get a triage Lead + an unmatched head (webhook parity, §11 — never an
// auto-created Contact).
// -----------------------------------------------------------------------------

interface DiscoverInput {
  client: TrengoClient
  endpoint: TrengoListEndpoint
  pages: number
  jobId: string
}

export async function discoverNewTickets(
  input: DiscoverInput,
): Promise<{ scanned: number; imported: number; failed: number }> {
  const { client, endpoint, pages, jobId } = input
  const windowFrom = new Date(Date.now() - DISCOVER_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const since = windowFrom.toISOString().slice(0, 10)

  // Trengo agent names for outbound attribution — best-effort, like backfill.
  let userNames: Record<string, string> = {}
  try {
    const res = await client.request<unknown>('GET', '/users?page=1&per_page=200')
    userNames = buildUserNameMap(parseListResponse<unknown>(res, 1).rows)
  } catch {
    // attribution resolves on the next successful team sync
  }

  let scanned = 0
  let imported = 0
  let failed = 0
  for (let page = 1; page <= pages; page += 1) {
    const listing = await listTicketsPage(client.request, page, endpoint, since)
    const tickets = listing.rows
      .map((raw) => normaliseTicketRow(raw))
      .filter((t): t is NormalisedTicket => t !== null)
      .filter((t) => ticketWithinWindow(t.createdAt, windowFrom))
    scanned += tickets.length
    if (tickets.length > 0) {
      const known = await db.conversation.findMany({
        where: { trengoTicketId: { in: tickets.map((t) => t.id) } },
        select: { trengoTicketId: true },
      })
      const knownIds = new Set(known.map((k) => k.trengoTicketId))
      for (const ticket of tickets) {
        if (knownIds.has(ticket.id)) continue
        try {
          await processTicket({
            client,
            endpoint: listing.endpoint,
            ticket,
            jobId,
            createContacts: false,
            actorId: null,
            userNames,
            attachUnmatched: true,
          })
          imported += 1
        } catch {
          // One odd ticket must not abort the sweep; the next tick retries it
          // (it still has no head, so it is re-discovered).
          failed += 1
        }
      }
    }
    if (!listing.hasNext) break
  }
  return { scanned, imported, failed }
}

// -----------------------------------------------------------------------------
// Inngest function.
// -----------------------------------------------------------------------------

export const trengoReconcileStatus = inngest.createFunction(
  {
    id: 'trengo/reconcile-status',
    name: 'Trengo: reconcile conversation status from source of truth',
    // The function id is the lock — only one sweep at a time.
    concurrency: { limit: 1 },
    retries: 2,
  },
  // Every 10 minutes. Mirrors the booking-site pull cadence (CLAUDE.md §15):
  // webhooks are the fast path, the pull is the safety net. Staff can also
  // force an immediate full re-sync from the inbox (trengo/reconcile-now).
  { cron: '*/10 * * * *' },
  async ({ runId, step, logger }) => {
    // A valid (non-deleted, non-expired) per-agent token can list the whole
    // workspace's tickets — Trengo API tokens are workspace-scoped. We pick
    // the longest-lived one so the sweep keeps working as others rotate out.
    const agentId = await step.run('select-token', async () => {
      const tok = await db.trengoToken.findFirst({
        where: { deletedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
        select: { agentId: true },
      })
      return tok?.agentId ?? null
    })
    if (!agentId) {
      logger.info('no connected Trengo token — skipping reconcile')
      return { skipped: true, reason: 'no_token' }
    }

    let client: TrengoClient
    try {
      client = await createClientForAgent({
        agentId,
        purpose: 'trengo.reconcile',
        requestId: runId,
      })
    } catch (err) {
      // TOKEN_EXPIRED between selection and use — let the next tick pick a
      // different token rather than failing the whole sweep loudly.
      logger.warn({ err }, 'reconcile could not build a Trengo client — skipping tick')
      return { skipped: true, reason: 'client_unavailable' }
    }

    // Decide the listing endpoint once (cheap probe) so each per-ticket fetch
    // hits the right path without re-probing.
    const endpoint = await step.run('detect-endpoint', async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const page = await listTicketsPage(client.request, 1, null, since)
      return page.endpoint
    })

    // Discovery FIRST — import tickets Trengo has that we do not, so a broken
    // webhook subscription can no longer hide new conversations. Best-effort:
    // a listing failure must not stop the per-head convergence below.
    const discovered = await step.run('discover-new-tickets', async () => {
      try {
        return await discoverNewTickets({
          client,
          endpoint,
          pages: DISCOVER_PAGES_CRON,
          jobId: runId,
        })
      } catch (err) {
        logger.warn({ err }, 'trengo discovery sweep failed — continuing with convergence')
        return { scanned: 0, imported: 0, failed: 0 }
      }
    })

    const heads = await step.run('select-heads', async () =>
      db.conversation.findMany({
        where: {
          trengoTicketId: { not: null },
          OR: [{ provider: null }, { provider: 'trengo' }],
        },
        orderBy: [{ lastSyncCheckAt: { sort: 'asc', nulls: 'first' } }],
        take: BATCH,
        select: {
          id: true,
          trengoTicketId: true,
          status: true,
          trengoAssigneeId: true,
          tags: true,
          contactId: true,
          familyId: true,
          channel: true,
          trengoChannelId: true,
          trengoChannelName: true,
          lastMessageAt: true,
        },
      }),
    )
    if (heads.length === 0) {
      return { checked: 0, converged: 0, discovered: discovered.imported }
    }

    let converged = 0
    let deleted = 0
    for (const head of heads) {
      const ticketId = head.trengoTicketId
      if (ticketId === null) continue
      const result = await step.run(`reconcile-ticket-${ticketId}`, async () =>
        reconcileOne({ client, endpoint, head: { ...head, trengoTicketId: ticketId }, runId }),
      )
      if (result.converged) converged += 1
      if (result.deleted) deleted += 1
    }

    logger.info(
      { checked: heads.length, converged, deleted, discovered },
      'trengo reconcile-status tick complete',
    )
    return { checked: heads.length, converged, deleted, discovered: discovered.imported }
  },
)

// -----------------------------------------------------------------------------
// On-demand "Sync from Trengo" — staff-triggered immediate convergence of the
// most-recently-active OPEN conversations, so "closed on Trengo, still open
// here" clears within minutes instead of waiting for the round-robin cron.
// -----------------------------------------------------------------------------

export const trengoReconcileNow = inngest.createFunction(
  {
    id: 'trengo/reconcile-now',
    name: 'Trengo: force-sync conversation status now',
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: 'trengo/reconcile-now.requested' },
  async ({ runId, step, logger }) => {
    const agentId = await step.run('select-token', async () => {
      const tok = await db.trengoToken.findFirst({
        where: { deletedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
        select: { agentId: true },
      })
      return tok?.agentId ?? null
    })
    if (!agentId) return { skipped: true, reason: 'no_token' }

    let client: TrengoClient
    try {
      client = await createClientForAgent({ agentId, purpose: 'trengo.reconcile_now', requestId: runId })
    } catch (err) {
      logger.warn({ err }, 'reconcile-now could not build a Trengo client')
      return { skipped: true, reason: 'client_unavailable' }
    }
    const endpoint = await step.run('detect-endpoint', async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const page = await listTicketsPage(client.request, 1, null, since)
      return page.endpoint
    })

    // Staff pressed "Sync from Trengo" — dig deeper than the cron for tickets
    // we have never seen, THEN converge the open set. Best-effort so a listing
    // hiccup still lets the convergence below run.
    const discovered = await step.run('discover-new-tickets', async () => {
      try {
        return await discoverNewTickets({
          client,
          endpoint,
          pages: DISCOVER_PAGES_SYNC_NOW,
          jobId: runId,
        })
      } catch (err) {
        logger.warn({ err }, 'trengo discovery sweep failed — continuing with convergence')
        return { scanned: 0, imported: 0, failed: 0 }
      }
    })

    // The set most likely to be wrongly-open: OPEN / SNOOZED heads, newest
    // activity first (a ticket closed in Trengo was usually active recently).
    const heads = await step.run('select-open-heads', async () =>
      db.conversation.findMany({
        where: {
          trengoTicketId: { not: null },
          status: { in: ['open', 'snoozed'] },
          OR: [{ provider: null }, { provider: 'trengo' }],
        },
        orderBy: [{ lastMessageAt: 'desc' }],
        take: SYNC_NOW_CAP,
        select: {
          id: true,
          trengoTicketId: true,
          status: true,
          trengoAssigneeId: true,
          tags: true,
          contactId: true,
          familyId: true,
          channel: true,
          trengoChannelId: true,
          trengoChannelName: true,
          lastMessageAt: true,
        },
      }),
    )
    if (heads.length === 0) {
      return { checked: 0, converged: 0, discovered: discovered.imported }
    }

    let converged = 0
    for (const head of heads) {
      const ticketId = head.trengoTicketId
      if (ticketId === null) continue
      const result = await step.run(`sync-now-${ticketId}`, async () =>
        reconcileOne({ client, endpoint, head: { ...head, trengoTicketId: ticketId }, runId }),
      )
      if (result.converged) converged += 1
    }
    logger.info(
      { checked: heads.length, converged, discovered },
      'trengo reconcile-now complete',
    )
    return { checked: heads.length, converged, discovered: discovered.imported }
  },
)

interface ReconcileOneInput {
  client: TrengoClient
  endpoint: TrengoListEndpoint
  head: ReconcileHead
  runId: string
}

/**
 * Re-fetch one ticket, converge the head, stamp the cursor. Idempotent: the
 * merger is monotonic and keyed on `trengoTicketId`; the audit write dedupes
 * on `(requestId, action, target)` with `requestId` pinned to the run id, so a
 * retry replays the same outcome.
 */
async function reconcileOne(
  input: ReconcileOneInput,
): Promise<{ converged: boolean; deleted: boolean }> {
  const { client, endpoint, head, runId } = input
  const fetched = await fetchTicketDetail(client.request, endpoint, head.trengoTicketId)
  if (fetched.deleted) {
    // Ticket DELETED in Trengo — converge the head OUT of the active inbox so the
    // CRM mirrors Trengo (a deleted ticket is hidden there; leaving it `open`
    // here is exactly the "tickets hidden on Trengo still showing in the CRM"
    // drift). We never hard-delete the head (CLAUDE.md §3): move it to `archived`
    // — out of every active folder, but recoverable + auditable.
    let converged = false
    if (head.status !== 'archived') {
      await db.conversation.updateMany({
        where: { trengoTicketId: head.trengoTicketId, status: { not: 'archived' } },
        data: { status: 'archived' },
      })
      converged = true
      if (head.contactId || head.familyId) {
        await writeAuditLogEntry(db, {
          actorId: null,
          action: 'trengo.status_reconciled',
          target: head.familyId
            ? { type: 'Family', id: head.familyId }
            : { type: 'Contact', id: head.contactId as string },
          requestId: `${runId}:reconcile-deleted:${head.trengoTicketId}`,
          after: {
            ticketId: head.trengoTicketId,
            from: head.status,
            to: 'archived',
            source: 'reconcile',
            reason: 'deleted_in_trengo',
          },
        })
      }
    }
    await stampChecked(head.trengoTicketId)
    return { converged, deleted: true }
  }
  if (!fetched.ticket) {
    // Unparsable response (not a 404) — never mutate on ambiguity (§3); just
    // advance the cursor so the sweep moves on.
    await stampChecked(head.trengoTicketId)
    return { converged: false, deleted: false }
  }
  const ticket = fetched.ticket
  const plan = planReconcile(head, ticket)

  let converged = false
  // A reconcile-driven flip is NOT new activity: replay it at the head's own
  // lastMessageAt so a weeks-old drift correction never bumps the
  // conversation to the top of the inbox. The merger applies status /
  // assignee patches regardless of the timestamp.
  const occurredAt = new Date(head.lastMessageAt)

  if (plan.statusEvent) {
    await applyEventToConversation(db, {
      ticketId: head.trengoTicketId,
      eventName: plan.statusEvent,
      occurredAt,
      channel: head.channel,
      contactId: head.contactId,
      familyId: head.familyId,
    })
    converged = true
    if (plan.statusChange && (head.contactId || head.familyId)) {
      await writeAuditLogEntry(db, {
        actorId: null,
        action: 'trengo.status_reconciled',
        target: head.familyId
          ? { type: 'Family', id: head.familyId }
          : { type: 'Contact', id: head.contactId as string },
        requestId: `${runId}:reconcile:${head.trengoTicketId}`,
        after: {
          ticketId: head.trengoTicketId,
          from: plan.statusChange.from,
          to: plan.statusChange.to,
          source: 'reconcile',
        },
      })
    }
  }

  if (plan.applyAssignee && ticket.assigneeId !== null) {
    const assigneeUserId = await resolveAssignee(ticket.assigneeId)
    await applyEventToConversation(db, {
      ticketId: head.trengoTicketId,
      eventName: 'ticket.assigned',
      occurredAt,
      channel: head.channel,
      contactId: head.contactId,
      familyId: head.familyId,
      trengoAssigneeId: ticket.assigneeId,
      assigneeUserId,
    })
    converged = true
  }

  if (plan.clearAssignee) {
    // Unassigned in Trengo — mirror it. The event merger has no unassign
    // transition (webhooks only ever carry a new assignee), so clear the
    // head directly; updateMany is a safe no-op if the row vanished.
    await db.conversation.updateMany({
      where: { trengoTicketId: head.trengoTicketId },
      data: { trengoAssigneeId: null, assigneeUserId: null },
    })
    converged = true
  }

  if (plan.setSpam) {
    // Trengo Spam box — set the head status directly (no spam Interaction
    // event). Audited like a status flip so the change is traceable.
    await db.conversation.updateMany({
      where: { trengoTicketId: head.trengoTicketId, status: { not: 'spam' } },
      data: { status: 'spam' },
    })
    converged = true
    if (plan.statusChange && (head.contactId || head.familyId)) {
      await writeAuditLogEntry(db, {
        actorId: null,
        action: 'trengo.status_reconciled',
        target: head.familyId
          ? { type: 'Family', id: head.familyId }
          : { type: 'Contact', id: head.contactId as string },
        requestId: `${runId}:reconcile-spam:${head.trengoTicketId}`,
        after: {
          ticketId: head.trengoTicketId,
          from: plan.statusChange.from,
          to: plan.statusChange.to,
          source: 'reconcile',
        },
      })
    }
  }

  if (plan.tags) {
    // FULL set sync (not additive) so a label removed in Trengo disappears
    // here too. updateMany is a safe no-op if the row vanished mid-sweep.
    await db.conversation.updateMany({
      where: { trengoTicketId: head.trengoTicketId },
      data: { tags: plan.tags },
    })
    converged = true
  }

  if (plan.channelId !== null) {
    // The SPECIFIC Trengo channel ("business number"). Resolve its display
    // name from the channel mirror when the ticket didn't carry one.
    let channelName = ticket.trengoChannelName
    if (!channelName) {
      const ch = await db.trengoChannel.findUnique({
        where: { trengoId: plan.channelId },
        select: { name: true },
      })
      channelName = ch?.name ?? null
    }
    await db.conversation.updateMany({
      where: { trengoTicketId: head.trengoTicketId },
      data: {
        trengoChannelId: plan.channelId,
        ...(channelName ? { trengoChannelName: channelName } : {}),
      },
    })
    converged = true
  }

  await stampChecked(head.trengoTicketId)
  return { converged, deleted: false }
}

/** Resolve a Trengo agent id to a CRM user, via the TrengoUser mirror first
 *  (covers agents who never logged into the CRM) then `User.trengoUserId`. */
async function resolveAssignee(trengoUserId: number): Promise<string | null> {
  const mirror = await db.trengoUser.findUnique({
    where: { trengoUserId },
    select: { crmUserId: true },
  })
  if (mirror?.crmUserId) return mirror.crmUserId
  const user = await db.user.findUnique({
    where: { trengoUserId },
    select: { id: true },
  })
  return user?.id ?? null
}

async function stampChecked(ticketId: number): Promise<void> {
  await db.conversation.updateMany({
    where: { trengoTicketId: ticketId },
    data: { lastSyncCheckAt: new Date() },
  })
}
