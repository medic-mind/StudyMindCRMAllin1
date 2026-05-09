import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAxiomBatcher } from './axiom-transport'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

describe('axiom batcher', () => {
  it('flushes when MAX_BATCH is reached', async () => {
    const calls: Array<{ url: string; body: string }> = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const batcher = createAxiomBatcher({ token: 't', dataset: 'd' })
    for (let i = 0; i < 100; i++) batcher.push({ i })
    await new Promise((r) => setImmediate(r))
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain('/v1/datasets/d/ingest')
    const parsed = JSON.parse(calls[0]?.body ?? '[]')
    expect(parsed).toHaveLength(100)
  })

  it('flush() drains the queue', async () => {
    const calls: number[] = []
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      const arr = JSON.parse(String(init?.body ?? '[]'))
      calls.push(arr.length)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const batcher = createAxiomBatcher({ token: 't', dataset: 'd' })
    batcher.push({ a: 1 })
    batcher.push({ a: 2 })
    await batcher.flush()
    expect(calls).toEqual([2])
  })

  it('drops on fetch error rather than throwing', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('axiom down')
    }) as unknown as typeof fetch
    const batcher = createAxiomBatcher({ token: 't', dataset: 'd' })
    batcher.push({ a: 1 })
    await expect(batcher.flush()).resolves.toBeUndefined()
  })
})
