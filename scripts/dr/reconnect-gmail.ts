/* eslint-disable no-console */
// DR Step 6: renew Gmail Pub/Sub watches for every connected mailbox.
// Gmail watches expire after 7 days (CLAUDE.md §14); after a DR cutover we
// re-issue them all immediately rather than waiting for the next cron tick.
//
// This script iterates `GmailAccount` rows, calls users.watch on each, and
// updates `GmailAccount.watchExpiresAt`. Idempotent — calling watch again
// just refreshes the lifetime.
//
// Env: GOOGLE_APPLICATION_CREDENTIALS, GMAIL_PUBSUB_TOPIC, DATABASE_URL.

import { PrismaClient } from '@prisma/client'

interface AccountRow {
  id: string
  emailAddress: string
  refreshToken: string
}

async function watchOne(account: AccountRow, topicName: string): Promise<{ historyId: string; expiration: string }> {
  // We import lazily so the script can fail fast if the SDK isn't installed.
  const { google } = await import('googleapis')
  const oauth2 = new google.auth.OAuth2(
    process.env['GMAIL_OAUTH_CLIENT_ID'],
    process.env['GMAIL_OAUTH_CLIENT_SECRET'],
  )
  oauth2.setCredentials({ refresh_token: account.refreshToken })
  const gmail = google.gmail({ version: 'v1', auth: oauth2 })
  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: { topicName, labelIds: ['INBOX'] },
  })
  return {
    historyId: String(res.data.historyId ?? ''),
    expiration: String(res.data.expiration ?? ''),
  }
}

async function main(): Promise<void> {
  const topic = process.env['GMAIL_PUBSUB_TOPIC']
  if (!topic) throw new Error('GMAIL_PUBSUB_TOPIC is not set')
  const prisma = new PrismaClient()
  try {
    // The GmailAccount model name follows Prisma camelCase; types are
    // unavailable here so we cast to a thin shape.
    const accounts = (await (prisma as unknown as {
      gmailAccount: {
        findMany: (args: unknown) => Promise<AccountRow[]>
      }
    }).gmailAccount.findMany({
      where: { deletedAt: null },
      select: { id: true, emailAddress: true, refreshToken: true },
    })) as AccountRow[]
    console.log(`renewing watches for ${accounts.length} mailbox(es)`)
    for (const a of accounts) {
      try {
        const r = await watchOne(a, topic)
        console.log(`renewed mailbox=${a.emailAddress} historyId=${r.historyId} expires=${r.expiration}`)
      } catch (err) {
        console.error(`failed mailbox=${a.emailAddress}`, err)
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
