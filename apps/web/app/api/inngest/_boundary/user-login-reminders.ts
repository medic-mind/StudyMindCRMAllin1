// Worker boundary: remind staff who were given a CRM account but have never
// signed in (ADR 0021 amendment / user-management upgrade). Daily. For each
// live, non-deactivated account that CAN sign in (has a password) but never
// has, past the grace period and under the nudge cap, we email a gentle
// reminder and stamp the count. Pure decision logic lives in
// `@studymind/core/auth/login-reminders`; this boundary does the I/O (query +
// system email). Disable with USER_LOGIN_REMINDERS=off. No mailbox connected →
// skip (retries next day).

import {
  resolveLoginReminderConfig,
  shouldRemindLogin,
} from '@studymind/core/auth/login-reminders'
import { buildLoginReminderEmail } from '@studymind/core/email'
import { writeAuditLogEntry } from '@studymind/audit'
import { inngest } from '@studymind/jobs'
import { sendSystemEmail } from '@studymind/integration-gmail/system-send'

import { db } from '@/lib/db'

function appUrl(): string {
  return (
    process.env['NEXT_PUBLIC_APP_URL'] ??
    process.env['APP_URL'] ??
    'http://localhost:3000'
  ).replace(/\/$/, '')
}

const MAX_PER_TICK = 200

export const userLoginReminders = inngest.createFunction(
  {
    id: 'users/login-reminders',
    name: 'Users: remind staff who have never signed in',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 9 * * *' },
  async ({ step, logger }) => {
    if ((process.env['USER_LOGIN_REMINDERS'] ?? '').toLowerCase() === 'off') {
      return { disabled: true, reminded: 0 }
    }
    const cfg = resolveLoginReminderConfig({
      firstAfterDays: process.env['USER_LOGIN_REMINDER_GRACE_DAYS'],
      cadenceDays: process.env['USER_LOGIN_REMINDER_CADENCE_DAYS'],
      maxReminders: process.env['USER_LOGIN_REMINDER_MAX'],
    })
    const now = new Date()

    const candidates = await step.run('list-candidates', async () => {
      const rows = await db.user.findMany({
        where: {
          deletedAt: null,
          deactivatedAt: null,
          passwordHash: { not: null },
          lastSignInAt: null,
          loginReminderCount: { lt: cfg.maxReminders },
        },
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          lastSignInAt: true,
          lastLoginReminderAt: true,
          loginReminderCount: true,
        },
        take: MAX_PER_TICK,
      })
      return rows
        .filter((u) => shouldRemindLogin(u, now, cfg))
        .map((u) => ({ id: u.id, email: u.email, name: u.name }))
    })

    const signInUrl = `${appUrl()}/sign-in`
    let reminded = 0
    for (const u of candidates) {
      const sent = await step.run(`remind-${u.id}`, async () => {
        const rendered = buildLoginReminderEmail({ name: u.name, signInUrl })
        const result = await sendSystemEmail({
          to: u.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        })
        if (result.status !== 'sent') return false
        await db.user.update({
          where: { id: u.id },
          data: { lastLoginReminderAt: new Date(), loginReminderCount: { increment: 1 } },
        })
        await writeAuditLogEntry(db, {
          actorId: null,
          action: 'auth.login_reminder_sent',
          target: { type: 'User', id: u.id },
          requestId: `login-reminder:${u.id}:${new Date().toISOString().slice(0, 10)}`,
          after: { emailStatus: result.status, manual: false },
        })
        return true
      })
      if (sent) reminded += 1
    }

    logger.info({ examined: candidates.length, reminded }, 'user login-reminders complete')
    return { examined: candidates.length, reminded }
  },
)
