// Minimal PagerDuty Events API v2 client. CLAUDE.md §25, §44.3.
//
// We use the Events API (not the REST API) because the only thing we need
// is to trigger incidents from the UEBA detector and from KMS break-glass
// (CLAUDE.md §21.1). Routing key is read from `PAGERDUTY_ROUTING_KEY`.
//
// All outbound goes through `safeFetch` per the SSRF allowlist.

import { safeFetch } from '@studymind/core/observability/safe-fetch'

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue' as const

export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info'

export interface PagerDutyEventInput {
  /** Short, single-line headline. */
  summary: string
  severity: PagerDutySeverity
  /** Stable dedup key — same key collapses into one open incident. */
  dedupKey: string
  /** Source identifier (a hostname, service name, or identifier of origin). */
  source?: string
  /** Free-form details payload. Avoid PII. */
  details?: Record<string, unknown>
  /** Routing key override; defaults to PAGERDUTY_ROUTING_KEY env. */
  routingKey?: string
  /** Test seam. */
  fetchImpl?: typeof fetch
}

export class PagerDutyApiError extends Error {
  override readonly name = 'PagerDutyApiError'
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`PagerDuty Events API ${status}: ${body}`)
  }
}

export interface PagerDutyEventResult {
  status: 'success' | 'skipped'
  dedupKey: string
}

/**
 * Fire a PagerDuty `trigger` event. Returns `skipped` when no routing key is
 * configured (local dev, CI) — callers do not need to special-case that.
 */
export async function triggerEvent(input: PagerDutyEventInput): Promise<PagerDutyEventResult> {
  const routingKey = input.routingKey ?? process.env['PAGERDUTY_ROUTING_KEY']
  if (!routingKey) {
    return { status: 'skipped', dedupKey: input.dedupKey }
  }

  const fetchImpl = input.fetchImpl ?? safeFetch
  const res = await fetchImpl(PAGERDUTY_EVENTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routing_key: routingKey,
      event_action: 'trigger',
      dedup_key: input.dedupKey,
      payload: {
        summary: input.summary,
        severity: input.severity,
        source: input.source ?? 'studymind-crm',
        custom_details: input.details ?? {},
      },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new PagerDutyApiError(res.status, body)
  }
  return { status: 'success', dedupKey: input.dedupKey }
}
