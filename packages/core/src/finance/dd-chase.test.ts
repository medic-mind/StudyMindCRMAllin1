import { describe, expect, it } from 'vitest'

import {
  chaseAutoResolved,
  decideChaseTick,
  nextChaseAt,
  type ChaseCaseState,
  type ChaseTemplateRef,
} from './dd-chase'

const now = new Date('2026-07-19T12:00:00Z')

function tpl(id: string, channel: 'email' | 'sms'): ChaseTemplateRef {
  return { id, channel, subject: channel === 'email' ? `s-${id}` : null, body: `b-${id}` }
}

function cs(overrides: Partial<ChaseCaseState> = {}): ChaseCaseState {
  return {
    status: 'chasing',
    autoChase: true,
    sendEmails: true,
    sendTexts: true,
    chaseEmail: 'p@x.com',
    chasePhoneE164: '+447700900123',
    setupLinkUrl: 'https://pay.gocardless.com/x',
    escalationStep: 0,
    nextAutoMessageAt: new Date(now.getTime() - 60_000),
    ...overrides,
  }
}

const emails = [tpl('e1', 'email'), tpl('e2', 'email'), tpl('e3', 'email')]
const texts = [tpl('s1', 'sms'), tpl('s2', 'sms')]

describe('decideChaseTick', () => {
  it('sends on every enabled channel at the current escalation step', () => {
    const d = decideChaseTick({ cs: cs(), now, emailTemplates: emails, smsTemplates: texts })
    expect(d.kind).toBe('send')
    if (d.kind !== 'send') return
    expect(d.sends).toHaveLength(2)
    expect(d.sends[0]).toMatchObject({ channel: 'email', to: 'p@x.com', template: emails[0] })
    expect(d.sends[1]).toMatchObject({ channel: 'sms', template: texts[0] })
  })

  it('escalates: step 1 sends the second (more serious) template', () => {
    const d = decideChaseTick({
      cs: cs({ escalationStep: 1 }),
      now,
      emailTemplates: emails,
      smsTemplates: texts,
    })
    if (d.kind !== 'send') throw new Error('expected send')
    expect(d.sends[0]!.template.id).toBe('e2')
    expect(d.sends[1]!.template.id).toBe('s2')
  })

  it('clamps a shorter SMS sequence to its most serious message', () => {
    const d = decideChaseTick({
      cs: cs({ escalationStep: 2 }),
      now,
      emailTemplates: emails,
      smsTemplates: texts,
    })
    if (d.kind !== 'send') throw new Error('expected send')
    expect(d.sends[0]!.template.id).toBe('e3')
    expect(d.sends[1]!.template.id).toBe('s2') // clamped to last
  })

  it('flags exhausted once every enabled sequence has been fully sent', () => {
    const d = decideChaseTick({
      cs: cs({ escalationStep: 3 }),
      now,
      emailTemplates: emails,
      smsTemplates: texts,
    })
    expect(d.kind).toBe('exhausted')
  })

  it('never sends without the staff-pasted link', () => {
    const d = decideChaseTick({
      cs: cs({ setupLinkUrl: null }),
      now,
      emailTemplates: emails,
      smsTemplates: texts,
    })
    expect(d).toEqual({ kind: 'skip', reason: 'no_link' })
  })

  it('never sends when the person is marked up to date / written off', () => {
    for (const status of ['recovered', 'written_off'] as const) {
      expect(
        decideChaseTick({ cs: cs({ status }), now, emailTemplates: emails, smsTemplates: texts }),
      ).toEqual({ kind: 'skip', reason: 'closed' })
    }
  })

  it('respects the per-person master switch and channel flags', () => {
    expect(
      decideChaseTick({ cs: cs({ autoChase: false }), now, emailTemplates: emails, smsTemplates: texts }),
    ).toEqual({ kind: 'skip', reason: 'auto_off' })
    const emailOnly = decideChaseTick({
      cs: cs({ sendTexts: false }),
      now,
      emailTemplates: emails,
      smsTemplates: texts,
    })
    if (emailOnly.kind !== 'send') throw new Error('expected send')
    expect(emailOnly.sends).toHaveLength(1)
    expect(emailOnly.sends[0]!.channel).toBe('email')
    expect(
      decideChaseTick({
        cs: cs({ sendEmails: false, sendTexts: false }),
        now,
        emailTemplates: emails,
        smsTemplates: texts,
      }),
    ).toEqual({ kind: 'skip', reason: 'no_channel' })
  })

  it('waits until the cadence makes a message due', () => {
    const d = decideChaseTick({
      cs: cs({ nextAutoMessageAt: new Date(now.getTime() + 60_000) }),
      now,
      emailTemplates: emails,
      smsTemplates: texts,
    })
    expect(d).toEqual({ kind: 'skip', reason: 'not_due' })
    expect(
      decideChaseTick({
        cs: cs({ nextAutoMessageAt: null }),
        now,
        emailTemplates: emails,
        smsTemplates: texts,
      }),
    ).toEqual({ kind: 'skip', reason: 'not_due' })
  })

  it('skips channels with no destination or no templates', () => {
    const d = decideChaseTick({
      cs: cs({ chasePhoneE164: null }),
      now,
      emailTemplates: emails,
      smsTemplates: texts,
    })
    if (d.kind !== 'send') throw new Error('expected send')
    expect(d.sends.map((s) => s.channel)).toEqual(['email'])
    expect(
      decideChaseTick({ cs: cs({ sendEmails: false }), now, emailTemplates: emails, smsTemplates: [] }),
    ).toEqual({ kind: 'skip', reason: 'no_channel' })
  })
})

describe('nextChaseAt', () => {
  it('advances by the cadence, defaulting bad values to 3 days', () => {
    expect(nextChaseAt(now, 3).getTime()).toBe(now.getTime() + 3 * 86_400_000)
    expect(nextChaseAt(now, 0).getTime()).toBe(now.getTime() + 3 * 86_400_000)
    expect(nextChaseAt(now, Number.NaN).getTime()).toBe(now.getTime() + 3 * 86_400_000)
  })
})

describe('chaseAutoResolved', () => {
  const opened = new Date('2026-07-01T00:00:00Z')

  it('resolves on a fresh active mandate created after the case opened', () => {
    expect(
      chaseAutoResolved(opened, [{ status: 'active', createdAt: new Date('2026-07-10') }]),
    ).toBe(true)
  })

  it('ignores the old mandate that survived the cancelled plan', () => {
    expect(
      chaseAutoResolved(opened, [{ status: 'active', createdAt: new Date('2026-06-01') }]),
    ).toBe(false)
    expect(
      chaseAutoResolved(opened, [{ status: 'cancelled', createdAt: new Date('2026-07-10') }]),
    ).toBe(false)
    expect(chaseAutoResolved(opened, [])).toBe(false)
  })
})
