// Worker boundary for the weekly-webinar system. These functions need Stripe +
// Gmail integration glue, so they live at the app boundary (where importing
// integrations is allowed) rather than in `packages/jobs` (CLAUDE.md §17).
//
//   webinar/dispatch-weekly-emails   hourly — send due class emails
//   webinar/expire-enrollments       hourly — stop emails when subs lapse
//   webinar/zoom-rotation-reminder   weekly — nudge the team to rotate links
//   webinar/detect-enrollments       daily  — pick up new Stripe payers

import { createId } from '@paralleldrive/cuid2'

import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'
import { dispatchDueWebinarEmails } from '@/lib/webinar/dispatch-service'
import {
  detectEnrollmentsFromStripe,
  expireLapsedEnrollments,
} from '@/lib/webinar/enrollment-service'
import { sendDueRecordings, sendRecordingsForMeetingId } from '@/lib/webinar/recordings-service'
import { createZoomRotationTasks } from '@/lib/webinar/zoom-reminder-service'

export const webinarDispatchWeeklyEmails = inngest.createFunction(
  {
    id: 'webinar/dispatch-weekly-emails',
    name: 'Webinar: send due weekly class emails',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 * * * *' },
  async ({ step, logger }) => {
    const result = await step.run('dispatch', async () =>
      dispatchDueWebinarEmails(db, new Date(), createId()),
    )
    logger.info({ ...result }, 'webinar.dispatch.complete')
    return result
  },
)

export const webinarExpireEnrollments = inngest.createFunction(
  {
    id: 'webinar/expire-enrollments',
    name: 'Webinar: expire enrolments whose subscription lapsed',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '15 * * * *' },
  async ({ step, logger }) => {
    const result = await step.run('expire', async () =>
      expireLapsedEnrollments(db, new Date(), createId()),
    )
    logger.info({ ...result }, 'webinar.expire.complete')
    return result
  },
)

export const webinarZoomRotationReminder = inngest.createFunction(
  {
    // id kept stable across the auto-rotation upgrade (ADR 0035 amendment) so
    // Inngest treats it as the same function.
    id: 'webinar/zoom-rotation-reminder',
    name: 'Webinar: rotate stale Zoom links (auto), remind where off/failed',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '0 8 * * 1' },
  async ({ step, logger }) => {
    const result = await step.run('remind', async () => createZoomRotationTasks(db, new Date()))
    logger.info({ ...result }, 'webinar.zoom_reminder.complete')
    return result
  },
)

export const webinarDetectEnrollments = inngest.createFunction(
  {
    id: 'webinar/detect-enrollments',
    name: 'Webinar: detect new Stripe payers and organise them into classes',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '30 6 * * *' },
  async ({ step, logger }) => {
    const result = await step.run('detect', async () =>
      detectEnrollmentsFromStripe(db, {
        actorId: null,
        requestId: createId(),
        useAi: true,
      }),
    )
    logger.info({ ...result }, 'webinar.detect.complete')
    return result
  },
)

export const webinarSendRecordings = inngest.createFunction(
  {
    id: 'webinar/send-recordings',
    name: 'Webinar: email class recordings (Zoom) and optionally trash them',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '30 * * * *' },
  async ({ step, logger }) => {
    const result = await step.run('send-recordings', async () =>
      sendDueRecordings(db, new Date(), createId()),
    )
    logger.info({ ...result }, 'webinar.recordings.complete')
    return result
  },
)

// Real-time recording delivery off the Zoom `recording.completed` webhook
// (ADR 0035). The hourly sweep above is the backstop.
export const webinarRecordingCompleted = inngest.createFunction(
  {
    id: 'webinar/recording-completed',
    name: 'Webinar: email a class recording when Zoom signals it is ready',
    concurrency: { limit: 3 },
    retries: 3,
  },
  { event: 'webinar/recording.completed' },
  async ({ event, step, logger }) => {
    const meetingId = (event.data as { meetingId?: string }).meetingId
    if (!meetingId) return { skipped: true }
    const result = await step.run('send', async () =>
      sendRecordingsForMeetingId(db, meetingId, createId()),
    )
    logger.info({ meetingId, ...result }, 'webinar.recording_completed.handled')
    return result
  },
)

export const WEBINAR_BOUNDARY_FUNCTIONS = [
  webinarDispatchWeeklyEmails,
  webinarExpireEnrollments,
  webinarZoomRotationReminder,
  webinarDetectEnrollments,
  webinarSendRecordings,
  webinarRecordingCompleted,
]
