// Trengo historic backfill worker (ADR 0017).
//
// Walks Trengo's documented ticket listing (`GET /tickets?page=N` —
// developers.trengo.com/reference/list-all-tickets; the legacy
// `/conversations` path is kept as a fallback for older workspaces), fetches
// each ticket's messages (`GET /tickets/:id/messages`), matches the
// counterparty to a CRM Contact by phone+email, and persists `message`
// Interactions (idempotent on Trengo message id).
//
// Each imported ticket is ALSO replayed onto the `Conversation` head via the
// same merger the live webhook uses, so the comms centre / unified inbox
// shows the imported history immediately — without waiting for the separate
// conversation-heads migration job.

import { createId } from '@paralleldrive/cuid2'

import {
  incrementBackfillProgress,
  markBackfillCompleted,
  markBackfillFailed,
  markBackfillRunning,
} from '@studymind/core/backfill'
import { splitDisplayName } from '@studymind/core/contact/from-call'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClientForAgent, TrengoApiError, type TrengoClient } from './client'
import { applyEventToConversation } from './conversation-head'
import { extractNameFromMessages } from './name-extract'
import { coerceTrengoId, isTrengoChannel, type TrengoChannel } from './types'

interface BackfillRequestedData {
  jobId: string
  provider: 'trengo'
  agentId: string | null
  windowFrom: string
  windowTo: string
  /**
   * Manual import only: create a lightweight Contact for a conversation whose
   * sender is not already in the CRM (instead of skipping it). The auto-on-
   * connect 90-day backfill leaves this false and keeps its "matched only"
   * behaviour.
   */
  createContacts?: boolean
}

/** Which listing endpoint a run has settled on. `tickets` is the documented
 *  Trengo v2 path; `conversations` is the legacy assumed path kept as a
 *  fallback. Decided once on the first page and sticky for the run. */
export type TrengoListEndpoint = 'tickets' | 'conversations'

/** Hard ceilings so a malformed pagination response can never loop forever. */
const MAX_TICKET_PAGES = 2000
const MAX_MESSAGE_PAGES = 20

// -----------------------------------------------------------------------------
// Pure parsing helpers (exported for tests).
// -----------------------------------------------------------------------------

/**
 * Trengo timestamps arrive either as ISO 8601 or as `YYYY-MM-DD HH:mm:ss`
 * (no timezone — treated as UTC, matching how the webhook envelope's
 * occurred_at is handled). Returns null when unparseable.
 */
export function parseTrengoDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const s = raw.trim()
  const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)
    ? `${s.replace(' ', 'T')}Z`
    : s
  const d = new Date(candidate)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Trengo channel `type` tags (GET /channels) → our channel enum. */
const CHANNEL_TYPE_TO_CHANNEL: Record<string, TrengoChannel> = {
  WA_BUSINESS: 'whatsapp',
  WHATSAPP: 'whatsapp',
  SMS: 'sms',
  EMAIL: 'email',
  CHAT: 'web_chat',
  WEB_CHAT: 'web_chat',
}

/**
 * Normalise the channel however the listing returned it — a lowercase name
 * ("whatsapp"), a Trengo type tag ("WA_BUSINESS"), or a channel object
 * (`{ name, type }`). Unknown channels (Facebook, Telegram, …) return null:
 * the message still imports, only the typed channel chip is absent.
 */
export function normaliseTicketChannel(raw: unknown): TrengoChannel | null {
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase()
    if (isTrengoChannel(lower)) return lower
    return CHANNEL_TYPE_TO_CHANNEL[raw.toUpperCase()] ?? null
  }
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const key of ['type', 'name'] as const) {
      const v = o[key]
      if (typeof v === 'string') {
        const c = normaliseTicketChannel(v)
        if (c) return c
      }
    }
  }
  return null
}

/**
 * Infer message direction from the REST shape. The webhook gives a
 * `direction` field; the REST listing varies by version, so we fall through
 * `direction` → `type` → "an agent (user_id) sent it" → inbound.
 */
export function inferMessageDirection(
  m: Record<string, unknown>,
): 'message.inbound' | 'message.outbound' {
  for (const key of ['direction', 'type'] as const) {
    const v = m[key]
    if (typeof v === 'string') {
      const lower = v.toLowerCase()
      if (lower === 'outbound') return 'message.outbound'
      if (lower === 'inbound') return 'message.inbound'
    }
  }
  if (m['user_id'] != null && m['contact_id'] == null) return 'message.outbound'
  return 'message.inbound'
}

/** Message text however the API spells it (`body`, `message`, `text`). */
export function extractMessageBody(m: Record<string, unknown>): string | null {
  for (const key of ['body', 'message', 'text'] as const) {
    const v = m[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

/** Label names however the listing returns them — `labels: [{ name }]` rows
 *  or plain strings (some versions spell the array `tags`). */
export function extractTicketLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.trim() !== '') {
      out.push(item.trim())
    } else if (item !== null && typeof item === 'object') {
      const name = (item as Record<string, unknown>)['name']
      if (typeof name === 'string' && name.trim() !== '') out.push(name.trim())
    }
  }
  return [...new Set(out)]
}

/**
 * Trengo user id → display name, from the workspace's `GET /users` listing.
 * Field names vary across versions (`full_name`, `name`, `first_name` +
 * `last_name`); email is the last resort. Drives sender attribution on
 * imported outbound messages so the CRM shows WHO sent each reply, exactly
 * as Trengo does.
 */
export function buildUserNameMap(rows: unknown[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    const u = raw as Record<string, unknown>
    const id = typeof u['id'] === 'number' ? u['id'] : null
    if (id === null) continue
    const joined = [u['first_name'], u['last_name']]
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .join(' ')
    const name = [u['full_name'], u['name'], joined, u['email']].find(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    )
    if (name) map[String(id)] = name.trim()
  }
  return map
}

export interface ParsedListPage<T> {
  rows: T[]
  hasNext: boolean
  /** Total rows across all pages when the API reports it (`meta.total`). */
  total: number | null
}

/**
 * Parse a paginated Trengo list response (`{ data, meta, links }` per
 * developers.trengo.com/docs/pagination-1; a bare array is accepted too).
 * An empty page never reports hasNext so a malformed meta cannot loop.
 */
export function parseListResponse<T>(res: unknown, page: number): ParsedListPage<T> {
  if (Array.isArray(res)) {
    return { rows: res as T[], hasNext: false, total: res.length }
  }
  const o = (res ?? {}) as Record<string, unknown>
  const rows = Array.isArray(o['data']) ? (o['data'] as T[]) : []
  const meta = (o['meta'] ?? {}) as Record<string, unknown>
  const links = (o['links'] ?? {}) as Record<string, unknown>
  const lastPage = typeof meta['last_page'] === 'number' ? meta['last_page'] : null
  const total = typeof meta['total'] === 'number' ? meta['total'] : null
  const hasNext =
    rows.length > 0 &&
    (lastPage !== null
      ? page < lastPage
      : typeof links['next'] === 'string' && links['next'] !== '')
  return { rows, hasNext, total }
}

export interface TrengoTicketRow {
  id: number
  status?: string
  subject?: string | null
  channel?: unknown
  channels?: unknown
  labels?: unknown
  tags?: unknown
  contact?: { phone?: string; email?: string; name?: string }
  created_at?: string
  [key: string]: unknown
}

export interface NormalisedTicket {
  id: number
  channel: TrengoChannel | null
  /** The SPECIFIC Trengo channel ("business number") id + name when the row
   *  carried it. Drives "which line is this on" + the named-channel filter. */
  trengoChannelId: number | null
  trengoChannelName: string | null
  /** Trengo statuses (OPEN / ASSIGNED / CLOSED / SPAM / …) folded to ours.
   *  `spam` is the Trengo Spam box — imported, not just a CRM-side toggle. */
  status: 'open' | 'closed' | 'spam'
  /** True only when the raw status is one we explicitly recognise. An
   *  unrecognised or missing status folds to 'open' for DISPLAY, but sync
   *  paths must fail closed (§8) and never flip a closed head back open on
   *  an ambiguous payload. */
  statusKnown: boolean
  /** Trengo user id the ticket is assigned to, however the listing spells it
   *  (assignee/agent/user object or *_id field). Null when unassigned. */
  assigneeId: number | null
  subject: string | null
  labels: string[]
  /** Whether the listing row carried a labels/tags key at all. When it did
   *  not, the import fetches the ticket detail to read the labels — an empty
   *  listing field and "the listing never includes labels" must not both
   *  silently mean "no labels". */
  labelsKnown: boolean
  contact: { phone: string | null; email: string | null; name: string | null }
  createdAt: Date | null
  /** When the ticket last had activity, however the listing spells it
   *  (updated_at / last_message_at / latest_message.created_at). Lets the
   *  reconcile sweep spot "Trengo has newer messages than we do" and
   *  re-import just those tickets. Null when the listing carries no
   *  activity timestamp — then only webhooks deliver new messages. */
  activityAt: Date | null
}

/** The ticket's SPECIFIC channel ("business number") — id + display name —
 *  however the row spells it: a `channel` object `{id, name, type}`, a
 *  `channels[0]` object, or a `channel_id` with a separate name. Null when the
 *  row carried no channel id. Drives the named-channel column + filter. */
export function extractTicketChannelMeta(
  t: Record<string, unknown>,
): { trengoChannelId: number | null; trengoChannelName: string | null } {
  const candidates: unknown[] = [t['channel'], Array.isArray(t['channels']) ? (t['channels'] as unknown[])[0] : null]
  for (const c of candidates) {
    if (c !== null && typeof c === 'object') {
      const o = c as Record<string, unknown>
      const id = coerceTrengoId(o['id'])
      if (id !== null) {
        const name =
          typeof o['name'] === 'string' && o['name'].trim() !== '' ? o['name'].trim() : null
        return { trengoChannelId: id, trengoChannelName: name }
      }
    }
  }
  // Fall back to a flat channel_id / inbox_id with no embedded name.
  const flat = coerceTrengoId(t['channel_id']) ?? coerceTrengoId(t['inbox_id'])
  return { trengoChannelId: flat, trengoChannelName: null }
}

/** True when the raw ticket is in Trengo's Spam box. Trengo spells it as a
 *  `status` of "SPAM" or a boolean `is_spam`/`spam` flag depending on version. */
export function ticketIsSpam(t: Record<string, unknown>): boolean {
  if (typeof t['status'] === 'string' && t['status'].toLowerCase() === 'spam') return true
  if (t['is_spam'] === true || t['spam'] === true) return true
  return false
}

/** The ticket's assigned Trengo user, however the listing spells it —
 *  `assignee_id` / `agent_id` / `user_id`, or a nested `assignee` / `agent` /
 *  `user` object. Drives assignee sync so "Assigned" matches Trengo. */
export function extractTicketAssigneeId(t: Record<string, unknown>): number | null {
  const direct =
    coerceTrengoId(t['assignee_id']) ??
    coerceTrengoId(t['agent_id']) ??
    coerceTrengoId(t['user_id'])
  if (direct !== null) return direct
  for (const key of ['assignee', 'agent', 'user'] as const) {
    const v = t[key]
    if (v !== null && typeof v === 'object') {
      const id = coerceTrengoId((v as Record<string, unknown>)['id'])
      if (id !== null) return id
    }
  }
  return null
}

/** Fold a raw ticket row to the fields the import needs. Null on rows with
 *  no usable numeric id. */
/** Raw Trengo statuses we positively recognise as "the ticket is open".
 *  Anything outside this set (and not closed/spam) is treated as UNKNOWN —
 *  displayed as open, but never used to reopen a closed head (§8). */
const KNOWN_OPEN_STATUSES = new Set(['open', 'assigned', 'new', 'pending'])

/** The ticket's last-activity time, however the listing row spells it. */
export function extractTicketActivityAt(t: Record<string, unknown>): Date | null {
  const direct =
    parseTrengoDate(t['updated_at']) ?? parseTrengoDate(t['last_message_at'])
  if (direct) return direct
  for (const key of ['latest_message', 'last_message'] as const) {
    const v = t[key]
    if (v !== null && typeof v === 'object') {
      const nested = parseTrengoDate((v as Record<string, unknown>)['created_at'])
      if (nested) return nested
    }
  }
  return null
}

export function normaliseTicketRow(raw: unknown): NormalisedTicket | null {
  if (raw === null || typeof raw !== 'object') return null
  const t = raw as TrengoTicketRow
  if (typeof t.id !== 'number') return null
  const channel =
    normaliseTicketChannel(t.channel) ??
    (Array.isArray(t.channels) ? normaliseTicketChannel(t.channels[0]) : null)
  const channelMeta = extractTicketChannelMeta(t as Record<string, unknown>)
  const rawStatus = typeof t.status === 'string' ? t.status.toLowerCase() : null
  const isSpam = ticketIsSpam(t as Record<string, unknown>)
  const status: 'open' | 'closed' | 'spam' = isSpam
    ? 'spam'
    : rawStatus === 'closed'
      ? 'closed'
      : 'open'
  const statusKnown =
    isSpam || rawStatus === 'closed' || (rawStatus !== null && KNOWN_OPEN_STATUSES.has(rawStatus))
  return {
    id: t.id,
    channel,
    trengoChannelId: channelMeta.trengoChannelId,
    trengoChannelName: channelMeta.trengoChannelName,
    status,
    statusKnown,
    assigneeId: extractTicketAssigneeId(t as Record<string, unknown>),
    subject: typeof t.subject === 'string' && t.subject.trim() !== '' ? t.subject : null,
    labels: extractTicketLabels(t.labels ?? t.tags),
    labelsKnown: 'labels' in t || 'tags' in t,
    contact: {
      phone: t.contact?.phone?.trim() || null,
      email: t.contact?.email?.trim().toLowerCase() || null,
      name: t.contact?.name?.trim() || null,
    },
    createdAt: parseTrengoDate(t.created_at),
    activityAt: extractTicketActivityAt(t as Record<string, unknown>),
  }
}

/** Window check — a ticket with no parseable created_at imports anyway
 *  (fail open: losing history is worse than importing a little extra). */
export function ticketWithinWindow(createdAt: Date | null, windowFrom: Date): boolean {
  return createdAt === null || createdAt.getTime() >= windowFrom.getTime()
}

// -----------------------------------------------------------------------------
// Fetch layer.
// -----------------------------------------------------------------------------

type RequestFn = <T>(method: string, path: string) => Promise<T>

export interface TicketPageResult {
  rows: TrengoTicketRow[]
  hasNext: boolean
  total: number | null
  endpoint: TrengoListEndpoint
}

/**
 * Fetch one page of the ticket listing. Tries the documented `/tickets`
 * first; when the workspace rejects it with a 404/405 (and no endpoint has
 * been decided yet), falls back to the legacy `/conversations` path once and
 * the caller pins the choice for the rest of the run.
 */
export async function listTicketsPage(
  request: RequestFn,
  page: number,
  endpoint: TrengoListEndpoint | null,
  since: string,
): Promise<TicketPageResult> {
  const tryTickets = endpoint === null || endpoint === 'tickets'
  if (tryTickets) {
    try {
      const res = await request<unknown>('GET', `/tickets?page=${page}&per_page=50`)
      const parsed = parseListResponse<TrengoTicketRow>(res, page)
      return { ...parsed, endpoint: 'tickets' }
    } catch (err) {
      const status = err instanceof TrengoApiError ? err.status : 0
      const canFallBack = endpoint === null && (status === 404 || status === 405)
      if (!canFallBack) throw err
    }
  }
  const res = await request<unknown>(
    'GET',
    `/conversations?created_at_after=${since}&page=${page}&per_page=50`,
  )
  const parsed = parseListResponse<TrengoTicketRow>(res, page)
  return { ...parsed, endpoint: 'conversations' }
}

/** Labels from the ticket DETAIL — used when the listing row carried no
 *  labels/tags key at all. Best-effort: any failure yields []. */
async function fetchTicketDetailLabels(
  request: RequestFn,
  endpoint: TrengoListEndpoint,
  ticketId: number,
): Promise<string[]> {
  const base = endpoint === 'tickets' ? '/tickets' : '/conversations'
  try {
    const res = await request<unknown>('GET', `${base}/${ticketId}`)
    const root = (res ?? {}) as Record<string, unknown>
    const detail = (root['data'] ?? root) as Record<string, unknown>
    return extractTicketLabels(detail['labels'] ?? detail['tags'])
  } catch {
    return []
  }
}

/** All messages on one ticket, walking the paginated listing. A 404 on the
 *  messages path (ticket deleted between listing and fetch) yields []. */
async function fetchTicketMessages(
  request: RequestFn,
  endpoint: TrengoListEndpoint,
  ticketId: number,
): Promise<Array<Record<string, unknown>>> {
  const base =
    endpoint === 'tickets'
      ? `/tickets/${ticketId}/messages`
      : `/conversations/${ticketId}/messages`
  const out: Array<Record<string, unknown>> = []
  let page = 1
  for (;;) {
    let res: unknown
    try {
      res = await request<unknown>('GET', `${base}?page=${page}&per_page=200`)
    } catch (err) {
      if (err instanceof TrengoApiError && err.status === 404) return out
      throw err
    }
    const parsed = parseListResponse<Record<string, unknown>>(res, page)
    out.push(...parsed.rows)
    if (!parsed.hasNext || page >= MAX_MESSAGE_PAGES) return out
    page += 1
  }
}

// -----------------------------------------------------------------------------
// Inngest function.
// -----------------------------------------------------------------------------

export const trengoBackfillRequested = inngest.createFunction(
  {
    id: 'trengo/backfill.requested',
    name: 'Backfill historic Trengo conversations',
    concurrency: { limit: 2 },
    retries: 4,
  },
  { event: 'backfill/trengo.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as BackfillRequestedData
    const { jobId, agentId, windowFrom } = data
    const createContacts = data.createContacts ?? false
    if (!agentId) {
      await markBackfillFailed(db, jobId, 'trengo backfill requires agentId', jobId)
      return { skipped: true, reason: 'no_agent_id' }
    }

    await step.run('mark-running', async () => markBackfillRunning(db, jobId))

    let processed = 0
    let matched = 0
    let skipped = 0
    let created = 0
    let page = 1

    try {
      const client = await createClientForAgent({
        agentId,
        purpose: 'trengo.backfill',
        requestId: jobId,
      })
      const windowFromDate = new Date(windowFrom)
      const since = windowFromDate.toISOString().slice(0, 10) // YYYY-MM-DD

      // Workspace users, fetched once per run — outbound messages are
      // attributed to the Trengo agent who sent them (payload.senderName),
      // mirroring what Trengo's own thread shows. Best-effort: a workspace
      // whose token cannot list users imports without attribution.
      const userNames = await step.run('list-users', async () => {
        try {
          const res = await client.request<unknown>('GET', '/users?page=1&per_page=200')
          return buildUserNameMap(parseListResponse<unknown>(res, 1).rows)
        } catch {
          return {} as Record<string, string>
        }
      })

      // Mirror the FULL Trengo team into TrengoUser + auto-link to CRM users
      // by email, so assignment + name resolution reflect Trengo (§11).
      // Best-effort: a failure here must not abort the message import.
      await step.run('sync-team', async () => {
        try {
          const { syncTrengoTeam } = await import('./team')
          await syncTrengoTeam(db, agentId, jobId)
        } catch {
          // ignore — the import proceeds; the manual "Sync Trengo team" button
          // and the userNames map above still cover attribution.
        }
      })

      // Mirror the workspace's CHANNELS (named "business numbers") so the
      // inbox can list them by name and each conversation shows which line it
      // is on. Best-effort — the import proceeds regardless.
      await step.run('sync-channels', async () => {
        try {
          const { syncTrengoChannels } = await import('./channels')
          await syncTrengoChannels(db, agentId, jobId)
        } catch {
          // ignore — channel ids are still captured per conversation; the
          // names resolve on the next successful channel sync.
        }
      })

      let endpoint: TrengoListEndpoint | null = null
      let keepPaging = true
      while (keepPaging && page <= MAX_TICKET_PAGES) {
        const currentEndpoint: TrengoListEndpoint | null = endpoint
        const ticketsPage = (await step.run(
          `list-tickets-${page}`,
          async (): Promise<TicketPageResult> =>
            listTicketsPage(client.request, page, currentEndpoint, since),
        )) as TicketPageResult
        endpoint = ticketsPage.endpoint

        for (const raw of ticketsPage.rows) {
          const ticket = normaliseTicketRow(raw)
          if (!ticket) continue
          // The documented /tickets listing has no server-side date filter,
          // so the window is enforced here. Out-of-window tickets cost one
          // listing row and nothing else.
          if (!ticketWithinWindow(ticket.createdAt, windowFromDate)) continue
          try {
            const result = await step.run(`conv-${ticket.id}`, async () =>
              processTicket({
                client,
                endpoint: ticketsPage.endpoint,
                ticket,
                jobId,
                createContacts,
                actorId: agentId,
                userNames,
              }),
            )
            processed += result.processed
            matched += result.matched
            skipped += result.skipped
            created += result.created
          } catch (err) {
            // One ticket that fails (a contact write clash, an odd message
            // shape) must not abort the whole import. Skip it and keep
            // paging so the rest of the history lands.
            skipped += 1
            logger.warn(
              { jobId, ticketId: ticket.id, err },
              'trengo backfill: skipped a ticket that failed to import',
            )
          }
        }
        await step.run(`progress-${page}`, async () =>
          incrementBackfillProgress(db, jobId, {
            processed,
            matched,
            skipped,
            lastEventId:
              ticketsPage.rows[ticketsPage.rows.length - 1]?.id?.toString() ?? null,
          }),
        )
        keepPaging = ticketsPage.hasNext
        page += 1
      }

      await step.run('mark-completed', async () =>
        markBackfillCompleted(db, jobId, {
          processed,
          matched,
          skipped,
          totalCount: processed,
          requestId: jobId,
        }),
      )
      return { ok: true, processed, matched, skipped, created, endpoint }
    } catch (err) {
      logger.error({ jobId, agentId, err }, 'trengo backfill failed')
      await markBackfillFailed(
        db,
        jobId,
        err instanceof Error ? err.message : 'unknown error',
        jobId,
      )
      throw err
    }
  },
)

export interface ProcessTicketInput {
  client: TrengoClient
  endpoint: TrengoListEndpoint
  ticket: NormalisedTicket
  jobId: string
  /** Manual import: create a Contact for a sender not already in the CRM. */
  createContacts: boolean
  /** Stamped as createdById/updatedById on any Contact this creates. */
  actorId: string | null
  /** Trengo user id → display name (buildUserNameMap). */
  userNames: Record<string, string>
  /** Import a ticket whose sender matches NO Contact anyway: messages and the
   *  Conversation head are written with a null contact (exactly what the live
   *  webhook does for unmatched inbound) and a Lead is recorded for triage —
   *  never a silently created Contact (§11/§3). Used by the reconcile
   *  discovery sweep so a NEW Trengo ticket appears in the inbox even when
   *  the webhook that should have announced it was dropped. Backfills keep
   *  the historical matched-only behaviour (false). */
  attachUnmatched?: boolean
}

const MATCH_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  familyMembers: { select: { familyId: true } },
} as const

export async function processTicket(
  input: ProcessTicketInput,
): Promise<{ processed: number; matched: number; skipped: number; created: number }> {
  const { client, endpoint, ticket, createContacts, userNames } = input
  const attachUnmatched = input.attachUnmatched ?? false

  // Match the ticket's contact (phone first, email fallback — §11).
  const phone = ticket.contact.phone
  const email = ticket.contact.email
  let matchedContact:
    | { id: string; firstName: string | null; lastName: string | null }
    | null = null
  let contactId: string | null = null
  let familyId: string | null = null
  if (phone && phone.startsWith('+')) {
    const c = await db.contact.findFirst({
      where: { phoneE164: phone, deletedAt: null },
      select: MATCH_SELECT,
    })
    if (c) {
      matchedContact = c
      contactId = c.id
      familyId = c.familyMembers[0]?.familyId ?? null
    }
  }
  if (!contactId && email) {
    const c = await db.contact.findFirst({
      where: { email, deletedAt: null },
      select: MATCH_SELECT,
    })
    if (c) {
      matchedContact = c
      contactId = c.id
      familyId = c.familyMembers[0]?.familyId ?? null
    }
  }

  // Name-resolution waterfall step 1 (free, exact): a matched contact with
  // NO name at all takes the name Trengo holds for the customer — blanks
  // only, never overwrite (§3). This is what stops the inbox saying
  // "Contact" for people Trengo knows by name (phone-only or email-only
  // contacts created by the lead funnel / call resolver). Steps 2 (rules
  // over message text, free) and 3 (AI, LAST — §18) run after the message
  // loop below, only when this step had nothing to give.
  const matchedIsNameless =
    !!matchedContact && !matchedContact.firstName && !matchedContact.lastName
  if (matchedContact && matchedIsNameless && ticket.contact.name) {
    const split = splitDisplayName(ticket.contact.name)
    if (split.firstName) {
      await db.contact.update({
        where: { id: matchedContact.id },
        data: {
          firstName: split.firstName,
          lastName: split.lastName,
          updatedById: input.actorId,
        },
      })
    }
  }

  // Unknown sender + operator-triggered import → create a lightweight Contact
  // keyed on the sender's phone/email so the conversation has a home. The §11
  // "never auto-create a Contact from Trengo" rule is the *webhook* default
  // (spam routes); this explicit, role-gated bulk import is the deliberate
  // exception. New rows are tagged `referralSource: 'Trengo import'` so the
  // whole batch is filterable/reviewable. Dedup is the DB itself: the next
  // conversation from the same person matches the row we just created, so one
  // Contact is made per unique phone/email — and re-runs converge (the match
  // finds it, message Interactions dedupe on trengoMessageId).
  let created = 0
  if (!contactId && createContacts) {
    const newId = await createContactFromTicket(ticket, input.actorId)
    if (newId) {
      contactId = newId
      created = 1
    }
  }

  // Discovery sweep for a sender the CRM does not know: record a Lead for the
  // triage tray (deduped on phone/email so re-sweeps converge), mirroring the
  // live webhook's unmatched-inbound behaviour. Never a Contact (§11).
  if (!contactId && attachUnmatched && (phone || email)) {
    const existingLead = await db.lead.findFirst({
      where: {
        source: 'trengo',
        OR: [
          ...(phone ? [{ phoneE164: phone }] : []),
          ...(email ? [{ email }] : []),
        ],
      },
      select: { id: true },
    })
    if (!existingLead) {
      await db.lead.create({
        data: {
          id: createId(),
          source: 'trengo',
          rawPayload: { discoveredByReconcile: true, ticketId: ticket.id },
          phoneE164: phone,
          email,
          name: ticket.contact.name,
        },
      })
    }
  }

  // Whether the contact still has no name after step 1 — steps 2/3 below
  // only run for these.
  const contactNeedsName =
    contactId !== null &&
    !ticket.contact.name &&
    (matchedContact ? matchedIsNameless : created === 1)

  const messages = await fetchTicketMessages(client.request, endpoint, ticket.id)
  let processed = 0
  let matched = 0
  let skipped = 0
  // Every message (newly written or already present) is collected so the
  // conversation-head replay below converges on re-runs too.
  const headEvents: Array<{
    direction: 'message.inbound' | 'message.outbound'
    occurredAt: Date
    preview: string | null
  }> = []
  // The customer's own words, oldest first — input to waterfall steps 2/3.
  const inboundBodies: string[] = []

  for (const m of messages) {
    processed += 1
    if (!contactId && !attachUnmatched) {
      skipped += 1
      continue
    }
    const messageId = typeof m['id'] === 'number' ? m['id'] : null
    if (messageId === null) {
      skipped += 1
      continue
    }
    const direction = inferMessageDirection(m)
    const occurredAt = parseTrengoDate(m['created_at']) ?? new Date()
    const body = extractMessageBody(m)
    headEvents.push({ direction, occurredAt, preview: body })
    if (direction === 'message.inbound' && body && inboundBodies.length < 12) {
      inboundBodies.push(body)
    }

    // Sender attribution, exactly as Trengo's thread shows it: outbound rows
    // name the Trengo agent (user_id → workspace user), inbound rows name
    // the customer.
    const trengoUserId = typeof m['user_id'] === 'number' ? m['user_id'] : null
    const senderName =
      direction === 'message.outbound'
        ? trengoUserId !== null
          ? (userNames[String(trengoUserId)] ?? null)
          : null
        : (ticket.contact.name ?? null)

    // Dedupe against BOTH key spellings: imports write `trengoMessageId`, the
    // live webhook writes `messageId` (numeric or string). Matching only the
    // import key duplicated every webhook-captured message when a ticket was
    // re-imported — fatal now that the reconcile sweep refreshes active
    // tickets routinely.
    const existing = await db.interaction.findFirst({
      where: {
        OR: [
          { payload: { path: ['trengoMessageId'], equals: messageId } },
          { payload: { path: ['trengoMessageId'], equals: String(messageId) } },
          { payload: { path: ['messageId'], equals: messageId } },
          { payload: { path: ['messageId'], equals: String(messageId) } },
        ],
      },
      select: { id: true, payload: true },
    })
    if (existing) {
      matched += 1
      // A re-run enriches rows imported before sender attribution existed —
      // fills the blank, never overwrites (§3).
      const p = (existing.payload ?? {}) as Record<string, unknown>
      if (senderName && typeof p['senderName'] !== 'string') {
        await db.interaction.update({
          where: { id: existing.id },
          data: { payload: { ...p, senderName, trengoUserId } },
        })
      }
      continue
    }
    const ticketIdOnMessage =
      typeof m['ticket_id'] === 'number'
        ? m['ticket_id']
        : typeof m['conversation_id'] === 'number'
          ? m['conversation_id']
          : ticket.id
    await db.interaction.create({
      data: {
        id: createId(),
        type: 'message',
        contactId,
        familyId,
        occurredAt,
        summary: (body ?? '').slice(0, 280),
        payload: {
          backfill: true,
          interactionType: direction,
          trengoMessageId: messageId,
          ticketId: ticketIdOnMessage,
          channel: normaliseTicketChannel(m['channel']) ?? ticket.channel,
          body,
          senderName,
          trengoUserId,
        },
      },
    })
    matched += 1
  }

  // Name waterfall steps 2 + 3 — cheapest first, AI strictly last (§18):
  // deterministic extraction from the customer's own messages, then the
  // budget-capped contact_name_extraction mini-task. Blanks only (§3); the
  // updateMany re-checks blankness so a concurrent write is never clobbered.
  if (contactId && contactNeedsName && inboundBodies.length > 0) {
    const resolvedName =
      extractNameFromMessages(inboundBodies) ??
      (await aiExtractNameFromMessages(inboundBodies, input.jobId))
    if (resolvedName) {
      const split = splitDisplayName(resolvedName)
      if (split.firstName) {
        await db.contact.updateMany({
          where: {
            id: contactId,
            AND: [
              { OR: [{ firstName: null }, { firstName: '' }] },
              { OR: [{ lastName: null }, { lastName: '' }] },
            ],
          },
          data: {
            firstName: split.firstName,
            lastName: split.lastName,
            updatedById: input.actorId,
          },
        })
      }
    }
  }

  // Replay the ticket onto the Conversation head (ADR 0020 Phase 2) so the
  // comms centre / unified inbox lists the imported history immediately. The
  // merger is monotonic and keyed on trengoTicketId, so replays converge.
  // Backfills only build heads for tickets that have a CRM home (matched /
  // created contact); the discovery sweep (`attachUnmatched`) also builds
  // heads with a null contact — exactly what the live webhook does — so a
  // brand-new Trengo ticket is visible in the inbox for triage.
  //
  // The listing row is Trengo's CURRENT state, so this is also the status /
  // assignee re-sync: a re-run (the "Last 7 days quick sync") converges
  // open/closed/assigned with what Trengo shows right now.
  if (contactId || attachUnmatched) {
    headEvents.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    for (const ev of headEvents) {
      await applyEventToConversation(db, {
        ticketId: ticket.id,
        eventName: ev.direction,
        occurredAt: ev.occurredAt,
        channel: ticket.channel,
        contactId,
        familyId,
        subject: ticket.subject,
        preview: ev.preview,
      })
    }
    const lastAt =
      headEvents.length > 0
        ? headEvents[headEvents.length - 1]!.occurredAt
        : (ticket.createdAt ?? new Date())
    // Ticket labels mirror onto the head's tags — the same place the live
    // webhook's label.added events land, so the comms centre shows them.
    // When the listing row carried no labels key at all, read the ticket
    // detail rather than assuming "no labels".
    const labels = ticket.labelsKnown
      ? ticket.labels
      : await fetchTicketDetailLabels(client.request, endpoint, ticket.id)
    // FULL label sync (not additive): set the head's tags to Trengo's EXACT
    // current label set, so a label removed in Trengo also disappears here.
    // updateMany is a safe no-op if the head doesn't exist yet (it will once
    // the message/assignee/status replays above created it).
    await db.conversation.updateMany({
      where: { trengoTicketId: ticket.id },
      data: { tags: labels },
    })
    // The SPECIFIC Trengo channel ("business number") this ticket is on. The
    // listing may carry the channel name; otherwise resolve it from the
    // channel mirror so the head shows "Support Manager" not just "whatsapp".
    if (ticket.trengoChannelId !== null) {
      let channelName = ticket.trengoChannelName
      if (!channelName) {
        const ch = await db.trengoChannel.findUnique({
          where: { trengoId: ticket.trengoChannelId },
          select: { name: true },
        })
        channelName = ch?.name ?? null
      }
      await db.conversation.updateMany({
        where: { trengoTicketId: ticket.id },
        data: {
          trengoChannelId: ticket.trengoChannelId,
          ...(channelName ? { trengoChannelName: channelName } : {}),
        },
      })
    }
    // Assignee sync — Trengo's current assignee mirrors onto the head,
    // resolved to a CRM user via the TrengoUser mirror (crmUserId) or
    // User.trengoUserId when the agent also logs into the CRM.
    if (ticket.assigneeId !== null) {
      const mirror = await db.trengoUser.findUnique({
        where: { trengoUserId: ticket.assigneeId },
        select: { crmUserId: true },
      })
      const assigneeUserId =
        mirror?.crmUserId ??
        (
          await db.user.findUnique({
            where: { trengoUserId: ticket.assigneeId },
            select: { id: true },
          })
        )?.id ??
        null
      await applyEventToConversation(db, {
        ticketId: ticket.id,
        eventName: 'ticket.assigned',
        occurredAt: lastAt,
        channel: ticket.channel,
        contactId,
        familyId,
        trengoAssigneeId: ticket.assigneeId,
        assigneeUserId,
      })
    }
    // Status sync — ALL THREE directions (open / closed / spam). Trengo is the
    // source of truth (§4): a ticket closed or spam-boxed in Trengo must show
    // the same here. A CRM-side snooze is preserved (snooze is a local "open"
    // variant); only closed/spam heads reopen.
    if (ticket.status === 'spam') {
      // Spam isn't an Interaction event — set the head status directly.
      await db.conversation.updateMany({
        where: { trengoTicketId: ticket.id, status: { not: 'spam' } },
        data: { status: 'spam' },
      })
    } else if (ticket.status === 'closed') {
      await applyEventToConversation(db, {
        ticketId: ticket.id,
        eventName: 'ticket.closed',
        occurredAt: lastAt,
        channel: ticket.channel,
        contactId,
        familyId,
      })
    } else if (ticket.statusKnown) {
      const head = await db.conversation.findUnique({
        where: { trengoTicketId: ticket.id },
        select: { status: true },
      })
      // Trengo shows it open → reopen a head we have as closed OR spam
      // (Trengo un-marked it as spam). Guarded on `statusKnown` so an
      // unrecognised status never reopens a closed head (§8, fail closed).
      if (head?.status === 'closed' || head?.status === 'spam') {
        await applyEventToConversation(db, {
          ticketId: ticket.id,
          eventName: 'ticket.reopened',
          occurredAt: lastAt,
          channel: ticket.channel,
          contactId,
          familyId,
        })
      }
    }
  }

  return { processed, matched, skipped, created }
}

/**
 * Waterfall step 3 — AI name extraction, strictly LAST because it is the
 * only paid route (§18). Budget-capped (`contact_name_extraction`,
 * packages/ai/budget.ts); any failure — over budget, no API key, provider
 * down, low confidence — quietly resolves to null and the display fallback
 * (phone / email) covers the contact instead.
 */
async function aiExtractNameFromMessages(
  inboundBodies: string[],
  requestId: string,
): Promise<string | null> {
  try {
    const {
      buildContactNameExtractPrompt,
      CONTACT_NAME_EXTRACT_PROMPT_VERSION,
      contactNameExtractSchema,
      NAME_EXTRACT_THRESHOLD,
      runStructured,
    } = await import('@studymind/ai')
    const prompt = buildContactNameExtractPrompt({ inboundMessages: inboundBodies })
    const parsed = await runStructured({
      task: 'contact_name_extraction',
      promptVersion: CONTACT_NAME_EXTRACT_PROMPT_VERSION,
      schema: contactNameExtractSchema,
      schemaName: 'contact_name_extract',
      system: prompt.system,
      user: prompt.user,
      ctx: { requestId, backfill: true },
    })
    if (!parsed.name || parsed.confidence < NAME_EXTRACT_THRESHOLD) return null
    return parsed.name
  } catch {
    return null
  }
}

/**
 * Create a lightweight Contact from a Trengo ticket's sender details.
 * Returns the new id, or null when there is nothing to key the row on (no
 * E.164 phone and no email) — we never make nameless ghost rows. Mirrors the
 * call-channel onboarding (`resolveOrCreateContactForCall`).
 */
async function createContactFromTicket(
  ticket: NormalisedTicket,
  actorId: string | null,
): Promise<string | null> {
  const phone = ticket.contact.phone
  const email = ticket.contact.email
  const hasPhone = !!phone && phone.startsWith('+')
  if (!hasPhone && !email) return null

  const name = ticket.contact.name ?? ''
  const split = name ? splitDisplayName(name) : { firstName: '', lastName: null }
  const id = createId()
  await db.contact.create({
    data: {
      id,
      kind: 'unclassified',
      firstName: split.firstName || null,
      lastName: split.lastName,
      email,
      phoneE164: hasPhone ? phone : null,
      referralSource: 'Trengo import',
      createdById: actorId,
      updatedById: actorId,
    },
  })
  return id
}

export const BACKFILL_FUNCTIONS = [trengoBackfillRequested] as const
