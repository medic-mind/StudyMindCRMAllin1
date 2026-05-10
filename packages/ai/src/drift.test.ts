// Drift sampler tests. CLAUDE.md §18.3.

import { afterEach, describe, expect, it } from 'vitest'

import {
  sampleForDrift,
  setDriftSampleDb,
  setDriftSampleRate,
} from './drift'

afterEach(() => {
  setDriftSampleDb(null)
  setDriftSampleRate(0.01)
})

function makeFakeDb() {
  const created: unknown[] = []
  return {
    created,
    db: {
      driftSample: {
        create: async ({ data }: { data: unknown }) => {
          created.push(data)
          return data
        },
      },
    },
  }
}

describe('sampleForDrift', () => {
  it('is a no-op when no db is injected', async () => {
    setDriftSampleRate(1)
    await expect(
      sampleForDrift({
        task: 't',
        model: 'm',
        promptVersion: 'v',
        input: {},
        output: {},
        costUsd: 0,
      }),
    ).resolves.toBeUndefined()
  })

  it('persists when sample rate forces selection', async () => {
    const fake = makeFakeDb()
    setDriftSampleDb(fake.db)
    setDriftSampleRate(1)
    await sampleForDrift({
      task: 'status_summary',
      model: 'gpt-4o-mini',
      promptVersion: 'v1',
      input: { user: 'hello' },
      output: { headerLine: 'h', bodyLine: 'b' },
      costUsd: 0.0001,
    })
    expect(fake.created).toHaveLength(1)
  })

  it('skips when sample rate is 0', async () => {
    const fake = makeFakeDb()
    setDriftSampleDb(fake.db)
    setDriftSampleRate(0)
    await sampleForDrift({
      task: 'status_summary',
      model: 'gpt-4o-mini',
      promptVersion: 'v1',
      input: {},
      output: {},
      costUsd: 0,
    })
    expect(fake.created).toHaveLength(0)
  })

  it('swallows persistence errors so the AI call still returns', async () => {
    setDriftSampleDb({
      driftSample: {
        create: async () => {
          throw new Error('boom')
        },
      },
    })
    setDriftSampleRate(1)
    await expect(
      sampleForDrift({
        task: 't',
        model: 'm',
        promptVersion: 'v',
        input: {},
        output: {},
        costUsd: 0,
      }),
    ).resolves.toBeUndefined()
  })
})
