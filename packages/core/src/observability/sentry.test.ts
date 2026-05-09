import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerSentry, withSentry } from './sentry'

afterEach(() => {
  ;(globalThis as unknown as { Sentry?: unknown }).Sentry = undefined
})

describe('withSentry', () => {
  it('returns the function result on success', async () => {
    const wrapped = withSentry(async (n: number) => n * 2)
    expect(await wrapped(3)).toBe(6)
  })

  it('captures and re-throws on error when Sentry is registered', async () => {
    const captureException = vi.fn()
    registerSentry({ captureException })
    const boom = withSentry(
      async () => {
        throw new Error('kapow')
      },
      { provider: 'test' },
    )
    await expect(boom()).rejects.toThrow('kapow')
    expect(captureException).toHaveBeenCalledOnce()
    expect(captureException.mock.calls[0]?.[1]).toEqual({ tags: { provider: 'test' } })
  })

  it('is a no-op when Sentry is not registered', async () => {
    const boom = withSentry(async () => {
      throw new Error('silent')
    })
    await expect(boom()).rejects.toThrow('silent')
  })
})
