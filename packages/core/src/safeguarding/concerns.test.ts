// Tests for raiseConcern fan-out behaviour. CLAUDE.md §42.1.
//
// We mock encryptField (cross-module concern) and exercise the urgency
// branches: routine -> no PD/Slack/email; immediate -> all three.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./encrypt', () => ({
  encryptField: vi.fn(async () => ({ id: 'enc_1' })),
}))

vi.mock('@studymind/audit', () => ({
  writeAuditLogEntry: vi.fn(async () => 'a_1'),
}))

import { raiseConcern, type RaiseConcernCtx } from './concerns'

interface FakeFlag {
  id: string
  contactId: string
  state: string
  urgency: string
  dslUserId: string
}

function makeDb(flags: FakeFlag[] = []) {
  return {
    safeguardingFlag: {
      create: vi.fn(async ({ data }: { data: FakeFlag }) => {
        flags.push(data)
        return data
      }),
    },
    interaction: {
      create: vi.fn(async () => ({ id: 'i_1' })),
    },
  } as unknown as Parameters<typeof raiseConcern>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env['DEFAULT_DSL_USER_ID'] = 'dsl_1'
})

afterEach(() => {
  delete process.env['DEFAULT_DSL_USER_ID']
})

describe('raiseConcern', () => {
  it('does not page on routine urgency', async () => {
    const flags: FakeFlag[] = []
    const db = makeDb(flags)
    const pageOnCall: ReturnType<typeof vi.fn> = vi.fn(async () => {})
    const postSafeguardingAlert: ReturnType<typeof vi.fn> = vi.fn(async () => {})
    const emailDpo: ReturnType<typeof vi.fn> = vi.fn(async () => {})

    const ctx: RaiseConcernCtx = {
      actorId: 'u_1',
      requestId: 'req_1',
      pageOnCall,
      postSafeguardingAlert,
      emailDpo,
    }

    await raiseConcern(
      db,
      {
        contactId: 'c_1',
        raisedBy: 'u_1',
        sourceType: 'call',
        sourceId: null,
        urgency: 'routine',
        body: 'a routine concern',
        isInPlacement: false,
      },
      ctx,
    )

    expect(pageOnCall).not.toHaveBeenCalled()
    expect(postSafeguardingAlert).not.toHaveBeenCalled()
    expect(emailDpo).not.toHaveBeenCalled()
  })

  it('pages PagerDuty + Slack + email on immediate urgency, with redacted body only', async () => {
    const db = makeDb()
    const pageOnCall: ReturnType<typeof vi.fn> = vi.fn(async () => {})
    const postSafeguardingAlert: ReturnType<typeof vi.fn> = vi.fn(async () => {})
    const emailDpo: ReturnType<typeof vi.fn> = vi.fn(async () => {})

    await raiseConcern(
      db,
      {
        contactId: 'c_1',
        raisedBy: 'u_1',
        sourceType: 'call',
        sourceId: null,
        urgency: 'immediate',
        body: 'PLAINTEXT_THAT_MUST_NOT_LEAK',
        isInPlacement: true,
      },
      {
        actorId: 'u_1',
        requestId: 'req_1',
        pageOnCall,
        postSafeguardingAlert,
        emailDpo,
      },
    )

    expect(pageOnCall).toHaveBeenCalledTimes(1)
    expect(pageOnCall).toHaveBeenCalledWith(
      expect.objectContaining({
        urgency: 'immediate',
        contactId: 'c_1',
        dedupKey: expect.stringMatching(/^sg-imm:/),
      }),
    )

    expect(postSafeguardingAlert).toHaveBeenCalledTimes(1)
    const slackArg = (postSafeguardingAlert.mock.calls as unknown as Array<
      [{ redactedSummary: string }]
    >)[0]![0]
    expect(slackArg.redactedSummary).not.toContain('PLAINTEXT_THAT_MUST_NOT_LEAK')

    expect(emailDpo).toHaveBeenCalledTimes(1)
    const emailArg = (emailDpo.mock.calls as unknown as Array<
      [{ redactedSummary: string }]
    >)[0]![0]
    expect(emailArg.redactedSummary).not.toContain('PLAINTEXT_THAT_MUST_NOT_LEAK')
  })
})
