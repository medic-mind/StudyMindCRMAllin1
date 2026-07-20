import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LOGIN_REMINDER_CONFIG,
  resolveLoginReminderConfig,
  shouldRemindLogin,
} from './login-reminders'

const NOW = new Date('2026-07-20T09:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000)

describe('shouldRemindLogin', () => {
  const base = { lastSignInAt: null, lastLoginReminderAt: null, loginReminderCount: 0 }

  it('nudges an account created past the grace period that never signed in', () => {
    expect(shouldRemindLogin({ ...base, createdAt: daysAgo(3) }, NOW)).toBe(true)
  })

  it('waits out the grace period before the first nudge', () => {
    expect(shouldRemindLogin({ ...base, createdAt: daysAgo(1) }, NOW)).toBe(false)
  })

  it('never nudges someone who has signed in', () => {
    expect(shouldRemindLogin({ ...base, createdAt: daysAgo(30), lastSignInAt: daysAgo(1) }, NOW)).toBe(false)
  })

  it('respects the cadence between nudges', () => {
    expect(
      shouldRemindLogin({ createdAt: daysAgo(30), lastSignInAt: null, lastLoginReminderAt: daysAgo(1), loginReminderCount: 1 }, NOW),
    ).toBe(false)
    expect(
      shouldRemindLogin({ createdAt: daysAgo(30), lastSignInAt: null, lastLoginReminderAt: daysAgo(4), loginReminderCount: 1 }, NOW),
    ).toBe(true)
  })

  it('stops at the cap', () => {
    expect(
      shouldRemindLogin({ createdAt: daysAgo(30), lastSignInAt: null, lastLoginReminderAt: daysAgo(10), loginReminderCount: DEFAULT_LOGIN_REMINDER_CONFIG.maxReminders }, NOW),
    ).toBe(false)
  })
})

describe('resolveLoginReminderConfig', () => {
  it('defaults when env is empty', () => {
    expect(resolveLoginReminderConfig({})).toEqual(DEFAULT_LOGIN_REMINDER_CONFIG)
  })
  it('parses overrides and floors cadence at 1', () => {
    expect(resolveLoginReminderConfig({ firstAfterDays: '5', cadenceDays: '0', maxReminders: '7' })).toEqual({
      firstReminderAfterDays: 5,
      cadenceDays: 1,
      maxReminders: 7,
    })
  })
})
