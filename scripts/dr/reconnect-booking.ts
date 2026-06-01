/* eslint-disable no-console */
// DR Step 6: confirm the booking site service-account token is valid and
// the pull schedule is healthy. Booking is pull-based today (CLAUDE.md
// §15) so there is no webhook to register — we just verify connectivity.
//
// Env: BOOKING_API_BASE, BOOKING_API_TOKEN.

async function main(): Promise<void> {
  const base = process.env['BOOKING_API_BASE']
  const token = process.env['BOOKING_API_TOKEN']
  if (!base) throw new Error('BOOKING_API_BASE is not set')
  if (!token) throw new Error('BOOKING_API_TOKEN is not set')

  const res = await fetch(`${base.replace(/\/$/, '')}/health`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`booking health failed: ${res.status} ${await res.text()}`)
  }
  console.log('booking site reachable. Inngest cron will resume pulls on next tick.')
  console.log('To force an immediate pull, trigger booking/sync-students from the Inngest dashboard.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
