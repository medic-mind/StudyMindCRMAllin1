import { describe, expect, it } from 'vitest'

import {
  chaseAutoResolved,
  decideAutoArm,
  decideChaseTick,
  nextChaseAt,
  type AutoChaseConfig,
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

// A fresh auto-opened case: un-armed (sends off, no link), autoChase default on.
function unarmed(overrides: Partial<ChaseCaseState> = {}): ChaseCaseState {
  return cs({
    status: 'new',
    sendEmails: false,
    sendTexts: false,
    setupLinkUrl: null,
    escalationStep: 0,
    nextAutoMessageAt: null,
    ...overrides,
  })
}

function config(overrides: Partial<AutoChaseConfig> = {}): AutoChaseConfig {
  return {
    autoChaseEnabled: true,
    autoChaseSetupLinkUrl: 'https://pay.gocardless.com/global',
    autoChaseEmail: true,
    autoChaseSms: false,
    ...overrides,
  }
}

describe('decideAutoArm', () => {
  it('arms an un-touched case with the global link + email when enabled', () => {
    const patch = decideAutoArm(unarmed(), config(), now)
    expect(patch).not.toBeNull()
    expect(patch).toMatchObject({
      setupLinkUrl: 'https://pay.gocardless.com/global',
      recoveryStrategy: 'resend_link',
      sendEmails: true,
      sendTexts: false,
      nextAutoMessageAt: now,
    })
  })

  it('does nothing when auto-chase is off', () => {
    expect(decideAutoArm(unarmed(), config({ autoChaseEnabled: false }), now)).toBeNull()
  })

  it('does nothing without a global re-signup link (stays "needs link")', () => {
    expect(decideAutoArm(unarmed(), config({ autoChaseSetupLinkUrl: null }), now)).toBeNull()
    expect(decideAutoArm(unarmed(), config({ autoChaseSetupLinkUrl: '   ' }), now)).toBeNull()
  })

  it('never overrides a case a human already armed or configured', () => {
    expect(decideAutoArm(unarmed({ setupLinkUrl: 'https://human/link' }), config(), now)).toBeNull()
    expect(decideAutoArm(unarmed({ sendEmails: true }), config(), now)).toBeNull()
  })

  it('never re-arms a paused case', () => {
    expect(decideAutoArm(unarmed({ autoChase: false }), config(), now)).toBeNull()
  })

  it('does not arm a channel it cannot reach', () => {
    // Email selected but the case has no email → nothing to send on.
    expect(decideAutoArm(unarmed({ chaseEmail: null }), config(), now)).toBeNull()
    // SMS selected + a valid phone → arm SMS only.
    const patch = decideAutoArm(
      unarmed({ chaseEmail: null }),
      config({ autoChaseEmail: false, autoChaseSms: true }),
      now,
    )
    expect(patch).toMatchObject({ sendEmails: false, sendTexts: true })
  })

  it('will not text a non-E.164 phone', () => {
    expect(
      decideAutoArm(
        unarmed({ chaseEmail: null, chasePhoneE164: '07700900123' }),
        config({ autoChaseEmail: false, autoChaseSms: true }),
        now,
      ),
    ).toBeNull()
  })

  it('skips a closed case', () => {
    expect(decideAutoArm(unarmed({ status: 'recovered' }), config(), now)).toBeNull()
  })
})

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

  it('never sends without the staff-pasted link (re-signup goal, the default)', () => {
    const d = decideChaseTick({
      cs: cs({ setupLinkUrl: null }),
      now,
      emailTemplates: emails,
      smsTemplates: texts,
    })
    expect(d).toEqual({ kind: 'skip', reason: 'no_link' })
  })

  it('demand-full goal sends WITHOUT a re-signup link (chases for the full balance)', () => {
    const d = decideChaseTick({
      cs: cs({ setupLinkUrl: null, recoveryStrategy: 'demand_full' }),
      now,
      emailTemplates: emails,
      smsTemplates: texts,
    })
    expect(d.kind).toBe('send')
  })

  it('re-signup goal still requires the link even when set explicitly', () => {
    const d = decideChaseTick({
      cs: cs({ setupLinkUrl: null, recoveryStrategy: 'resend_link' }),
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
