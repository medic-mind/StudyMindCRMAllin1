// Zoom Server-to-Server OAuth client (ADR 0035). Dependency-free — token + REST
// over `safeFetch` (SSRF allowlist, §44.2). Used by the webinar system to:
//   - create a recurring meeting per class (open to all, cloud auto-recording),
//   - list a meeting's cloud recordings to email out after each session,
//   - move a recording to Zoom Trash once it has been sent (recoverable).
//
// Credentials are a Server-to-Server OAuth app's Account ID + Client ID/Secret,
// read from env. `isConfigured()` lets callers fail closed when Zoom is not set
// up (the whole feature is off until then).

import { safeFetch } from '@studymind/core/observability/safe-fetch'

import { createHmac } from 'node:crypto'

const TOKEN_URL = 'https://zoom.us/oauth/token'
const API_BASE = 'https://api.zoom.us/v2'

export interface ZoomConfig {
  accountId: string
  clientId: string
  clientSecret: string
}

export function readZoomConfig(): ZoomConfig | null {
  const accountId = process.env['ZOOM_ACCOUNT_ID']
  const clientId = process.env['ZOOM_CLIENT_ID']
  const clientSecret = process.env['ZOOM_CLIENT_SECRET']
  if (!accountId || !clientId || !clientSecret) return null
  return { accountId, clientId, clientSecret }
}

export function isConfigured(): boolean {
  return readZoomConfig() !== null
}

export class ZoomApiError extends Error {
  override readonly name = 'ZoomApiError'
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Zoom API ${status}: ${body}`)
  }
}

interface CachedToken {
  token: string
  expiresAt: number
}
let cached: CachedToken | null = null

/** Fetch (and cache) a Server-to-Server access token. */
export async function getAccessToken(config?: ZoomConfig, now = Date.now()): Promise<string> {
  const cfg = config ?? readZoomConfig()
  if (!cfg) throw new ZoomApiError(0, 'Zoom is not configured (set ZOOM_ACCOUNT_ID/CLIENT_ID/SECRET).')
  if (cached && cached.expiresAt > now + 60_000) return cached.token

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
  const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(cfg.accountId)}`
  const res = await safeFetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  const text = await res.text()
  if (!res.ok) throw new ZoomApiError(res.status, text)
  const json = JSON.parse(text) as { access_token: string; expires_in: number }
  cached = { token: json.access_token, expiresAt: now + json.expires_in * 1000 }
  return cached.token
}

/** Reset the cached token. Tests only. */
export function __resetZoomTokenForTests(): void {
  cached = null
}

async function api<T>(path: string, init: RequestInit, config?: ZoomConfig): Promise<T> {
  const token = await getAccessToken(config)
  const res = await safeFetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new ZoomApiError(res.status, text)
  return (text ? JSON.parse(text) : {}) as T
}

export interface CreateMeetingInput {
  /** The Zoom user (host) to create under — email or 'me'. */
  hostEmail?: string
  topic: string
  /** Weekly recurring meeting with no fixed end (type 8). */
  recurring?: boolean
  timezone?: string
  /** Local start "HH:MM" used only to seed the recurrence start_time. */
  agenda?: string
}

export interface ZoomMeeting {
  id: number
  join_url: string
  start_url?: string
}

/**
 * Create a recurring meeting that is open to all (join before host, no
 * registration, no waiting room) with cloud auto-recording enabled.
 */
export async function createRecurringMeeting(
  input: CreateMeetingInput,
  config?: ZoomConfig,
): Promise<ZoomMeeting> {
  const host = input.hostEmail || 'me'
  return api<ZoomMeeting>(
    `/users/${encodeURIComponent(host)}/meetings`,
    {
      method: 'POST',
      body: JSON.stringify({
        topic: input.topic,
        // 8 = recurring meeting with no fixed time.
        type: 8,
        timezone: input.timezone ?? 'Europe/London',
        agenda: input.agenda,
        settings: {
          join_before_host: true,
          jbh_time: 5,
          waiting_room: false,
          // 2 = no registration required (open to all with the link).
          approval_type: 2,
          // Record to the cloud automatically when the meeting starts.
          auto_recording: 'cloud',
          mute_upon_entry: true,
          meeting_authentication: false,
        },
      }),
    },
    config,
  )
}

/** The connected Zoom user. Used by the Settings "Test connection" check. */
export interface ZoomUser {
  id: string
  email: string
  account_id?: string
}

export async function getMe(config?: ZoomConfig): Promise<ZoomUser> {
  return api<ZoomUser>('/users/me', { method: 'GET' }, config)
}

/** Delete a meeting (invalidates its join link). Used when rotating/cleaning up. */
export async function deleteMeeting(meetingId: string | number, config?: ZoomConfig): Promise<void> {
  try {
    await api<unknown>(`/meetings/${encodeURIComponent(String(meetingId))}`, { method: 'DELETE' }, config)
  } catch (err) {
    // Already gone → fine.
    if (err instanceof ZoomApiError && err.status === 404) return
    throw err
  }
}

export interface ZoomRecordingFile {
  id: string
  recording_type: string
  file_type: string
  download_url: string
  play_url?: string
  recording_start: string
}

export interface ZoomRecordings {
  /** Occurrence UUID — the idempotency key for "emailed this recording". */
  uuid: string
  id?: number
  share_url?: string
  recording_files: ZoomRecordingFile[]
}

/** List cloud recordings for a meeting (most recent occurrences). */
export async function getMeetingRecordings(
  meetingId: string | number,
  config?: ZoomConfig,
): Promise<ZoomRecordings | null> {
  try {
    return await api<ZoomRecordings>(`/meetings/${encodeURIComponent(String(meetingId))}/recordings`, {
      method: 'GET',
    }, config)
  } catch (err) {
    if (err instanceof ZoomApiError && err.status === 404) return null
    throw err
  }
}

/**
 * Move a meeting's cloud recordings to Zoom Trash (recoverable for 30 days) by
 * default, or permanently delete when `permanent` is set. We default to trash so
 * a mistaken/over-eager send can be undone (CLAUDE.md §34).
 */
export async function trashMeetingRecordings(
  meetingId: string | number,
  opts: { permanent?: boolean } = {},
  config?: ZoomConfig,
): Promise<void> {
  const action = opts.permanent ? 'delete' : 'trash'
  await api<unknown>(
    `/meetings/${encodeURIComponent(String(meetingId))}/recordings?action=${action}`,
    { method: 'DELETE' },
    config,
  )
}

/* -------------------------------------------------------------------------- */
/* Webhooks (recording.completed + endpoint URL validation)                    */
/* -------------------------------------------------------------------------- */

export function readWebhookSecret(): string | null {
  return process.env['ZOOM_WEBHOOK_SECRET_TOKEN'] ?? null
}

/**
 * Verify a Zoom webhook signature. Zoom signs as:
 *   message   = `v0:${x-zm-request-timestamp}:${rawBody}`
 *   signature = `v0=${HMAC_SHA256(secretToken, message)}`  (header x-zm-signature)
 */
export function verifyWebhookSignature(input: {
  rawBody: string
  signature: string | null
  timestamp: string | null
  secret?: string | null
}): boolean {
  const secret = input.secret ?? readWebhookSecret()
  if (!secret || !input.signature || !input.timestamp) return false
  const message = `v0:${input.timestamp}:${input.rawBody}`
  const expected = `v0=${createHmac('sha256', secret).update(message).digest('hex')}`
  // Constant-time-ish compare (lengths match for same algo).
  if (expected.length !== input.signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ input.signature.charCodeAt(i)
  return diff === 0
}

/**
 * Response to Zoom's `endpoint.url_validation` challenge: echo the plainToken and
 * its HMAC under the secret token.
 */
export function buildUrlValidationResponse(
  plainToken: string,
  secret?: string | null,
): { plainToken: string; encryptedToken: string } | null {
  const s = secret ?? readWebhookSecret()
  if (!s) return null
  return {
    plainToken,
    encryptedToken: createHmac('sha256', s).update(plainToken).digest('hex'),
  }
}
