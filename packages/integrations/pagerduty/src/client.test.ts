import { describe, expect, it } from 'vitest'

import { triggerEvent } from './client'

describe('pagerduty.triggerEvent', () => {
  it('skips when no routing key is configured', async () => {
    const r = await triggerEvent({
      summary: 's',
      severity: 'error',
      dedupKey: 'd',
    })
    expect(r.status).toBe('skipped')
  })

  it('posts to events.pagerduty.com with the trigger payload when routing key is set', async () => {
    let captured: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: typeof url === 'string' ? url : url.toString(), init }
      return new Response('{}', { status: 202 })
    }) as unknown as typeof fetch
    const r = await triggerEvent({
      summary: 's',
      severity: 'error',
      dedupKey: 'd-1',
      routingKey: 'routing-key',
      details: { foo: 'bar' },
      fetchImpl,
    })
    expect(r.status).toBe('success')
    expect(captured.url).toBe('https://events.pagerduty.com/v2/enqueue')
    const body = JSON.parse((captured.init?.body as string) ?? '{}')
    expect(body.routing_key).toBe('routing-key')
    expect(body.event_action).toBe('trigger')
    expect(body.dedup_key).toBe('d-1')
    expect(body.payload.severity).toBe('error')
    expect(body.payload.custom_details).toEqual({ foo: 'bar' })
  })
})
