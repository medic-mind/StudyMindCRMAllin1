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
