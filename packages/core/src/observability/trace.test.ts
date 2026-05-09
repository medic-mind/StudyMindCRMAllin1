import { describe, expect, it } from 'vitest'

import { currentTraceId, withSpan } from './trace'

describe('trace helpers', () => {
  it('withSpan returns the function result', async () => {
    const result = await withSpan('test', async () => 42, { foo: 'bar' })
    expect(result).toBe(42)
  })

  it('withSpan re-throws and records exception', async () => {
    await expect(
      withSpan('test.error', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })

  it('currentTraceId is undefined outside a span (no SDK initialised)', () => {
    expect(currentTraceId()).toBeUndefined()
  })
})
