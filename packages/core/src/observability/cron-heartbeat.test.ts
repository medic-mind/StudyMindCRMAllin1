import { describe, expect, it, vi } from 'vitest'

import { recordCronRun, withCronHeartbeat, type CronRunDb } from './cron-heartbeat'

function fakeDb(): { db: CronRunDb; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = []
  return {
    db: {
      cronRun: {
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data)
          return data
        }),
      },
    },
    rows,
  }
}

describe('recordCronRun', () => {
  it('writes a row with the provided fields', async () => {
    const { db, rows } = fakeDb()
    const id = await recordCronRun(db, {
      functionId: 'finance/reconcile-all-families',
      success: true,
      durationMs: 12345,
    })
    expect(id).toBeTruthy()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.functionId).toBe('finance/reconcile-all-families')
    expect(rows[0]?.success).toBe(true)
  })
})

describe('withCronHeartbeat', () => {
  it('records success on happy path and returns the value', async () => {
    const { db, rows } = fakeDb()
    const out = await withCronHeartbeat(db, 'job/x', async () => 42)
    expect(out).toBe(42)
    expect(rows[0]?.success).toBe(true)
  })

  it('records failure and re-throws', async () => {
    const { db, rows } = fakeDb()
    await expect(
      withCronHeartbeat(db, 'job/x', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(rows[0]?.success).toBe(false)
    expect(rows[0]?.errorCode).toBe('Error')
  })
})
