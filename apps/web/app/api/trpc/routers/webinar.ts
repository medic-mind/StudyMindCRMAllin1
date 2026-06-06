// Weekly-webinar system router. Manages cohorts, holidays, classes, syllabi,
// enrolments and settings, plus the "detect from Stripe" organiser.
//
// Role model: all authenticated users can read; Manager+ manages (CLAUDE.md
// §20.1). Mutations are audited.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AUTO_ENROLL_CONFIDENCE,
  computeSessions,
  currentWeekInfo,
  formatSessionDateShort,
  formatSessionTime,
  levelLabel,
  sessionStartInstant,
  subjectLabel,
  webinarLevelSchema,
  webinarSubjectSchema,
  WEEKDAY_LABEL,
  zoomRotationDue,
} from '@studymind/core/webinar'

import {
  buildScheduleImportPrompt,
  runStructured,
  scheduleImportSchema,
  WEBINAR_SCHEDULE_IMPORT_PROMPT_VERSION,
} from '@studymind/ai'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'
import { sendSystemEmail } from '@studymind/integration-gmail/system-send'
import { outbound as trengoOutbound } from '@studymind/integration-trengo'
import { client as zoomClient } from '@studymind/integration-zoom'

import { detectEnrollmentsFromStripe } from '@/lib/webinar/enrollment-service'
import { importToText, parseScheduleFallback, type ImportKind } from '@/lib/webinar/import-helpers'
import { sendRecordingsForClassId } from '@/lib/webinar/recordings-service'

import { webinarLevelRouter, webinarSubjectRouter } from './webinar-catalogue'

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
])

function assertCanManage(role: UserRole): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only Manager or above can manage webinars' })
  }
}

/** Accept a YYYY-MM-DD string and return a UTC-midnight Date. */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .transform((s) => new Date(`${s}T00:00:00.000Z`))

const MAX_PDF_BYTES = 8 * 1024 * 1024

/* -------------------------------------------------------------------------- */
/* Cohorts + holidays                                                          */
/* -------------------------------------------------------------------------- */

const cohortRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.webinarCohort.findMany({
      where: { deletedAt: null },
      orderBy: { startsOn: 'desc' },
      include: { _count: { select: { classes: true, holidays: true } } },
    })
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      startsOn: c.startsOn.toISOString().slice(0, 10),
      endsOn: c.endsOn.toISOString().slice(0, 10),
      status: c.status,
      timezone: c.timezone,
      notes: c.notes,
      classCount: c._count.classes,
      holidayCount: c._count.holidays,
    }))
  }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const c = await ctx.db.webinarCohort.findFirst({
      where: { id: input.id, deletedAt: null },
      include: {
        holidays: { orderBy: { startsOn: 'asc' } },
        classes: {
          where: { deletedAt: null },
          orderBy: [{ subject: 'asc' }, { level: 'asc' }],
          include: { _count: { select: { enrollments: true } } },
        },
      },
    })
    if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
    return {
      id: c.id,
      name: c.name,
      startsOn: c.startsOn.toISOString().slice(0, 10),
      endsOn: c.endsOn.toISOString().slice(0, 10),
      status: c.status,
      timezone: c.timezone,
      notes: c.notes,
      holidays: c.holidays.map((h) => ({
        id: h.id,
        name: h.name,
        startsOn: h.startsOn.toISOString().slice(0, 10),
        endsOn: h.endsOn.toISOString().slice(0, 10),
      })),
      classes: c.classes.map((cl) => ({
        id: cl.id,
        subject: cl.subject,
        subjectLabel: subjectLabel(cl.subject),
        level: cl.level,
        levelLabel: levelLabel(cl.level),
        title: cl.title,
        active: cl.active,
        enrollmentCount: cl._count.enrollments,
      })),
    }
  }),

  create: auditedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(40),
        startsOn: dateSchema,
        endsOn: dateSchema,
        timezone: z.string().trim().min(1).max(64).default('Europe/London'),
        status: z.enum(['planning', 'active', 'archived']).default('planning'),
        notes: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      if (input.endsOn.getTime() <= input.startsOn.getTime()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'End date must be after start date.' })
      }
      const id = createId()
      try {
        await ctx.db.webinarCohort.create({
          data: {
            id,
            name: input.name,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            timezone: input.timezone,
            status: input.status,
            notes: input.notes ?? null,
            createdById: user.id,
            updatedById: user.id,
          },
        })
      } catch (err) {
        if (err instanceof Error && /Unique/i.test(err.message)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'A cohort with that name exists.' })
        }
        throw err
      }
      await ctx.audit({
        action: 'webinar.cohort_created',
        target: { type: 'WebinarCohort', id },
        after: { name: input.name, status: input.status },
      })
      return { id }
    }),

  setStatus: auditedProcedure
    .input(z.object({ id: z.string(), status: z.enum(['planning', 'active', 'archived']) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.webinarCohort.findUnique({
        where: { id: input.id },
        select: { status: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.webinarCohort.update({
        where: { id: input.id },
        data: { status: input.status, updatedById: user.id },
      })
      await ctx.audit({
        action: 'webinar.cohort_status_changed',
        target: { type: 'WebinarCohort', id: input.id },
        before,
        after: { status: input.status },
      })
      return { id: input.id }
    }),

  addHoliday: auditedProcedure
    .input(
      z.object({
        cohortId: z.string(),
        name: z.string().trim().min(1).max(80),
        startsOn: dateSchema,
        endsOn: dateSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const id = createId()
      await ctx.db.webinarHoliday.create({
        data: {
          id,
          cohortId: input.cohortId,
          name: input.name,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'webinar.holiday_added',
        target: { type: 'WebinarCohort', id: input.cohortId },
        after: { name: input.name },
      })
      return { id }
    }),

  removeHoliday: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const holiday = await ctx.db.webinarHoliday.findUnique({
        where: { id: input.id },
        select: { cohortId: true, name: true },
      })
      if (!holiday) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.webinarHoliday.delete({ where: { id: input.id } })
      await ctx.audit({
        action: 'webinar.holiday_removed',
        target: { type: 'WebinarCohort', id: holiday.cohortId },
        before: { name: holiday.name },
      })
      return { id: input.id }
    }),
})

/* -------------------------------------------------------------------------- */
/* Classes                                                                     */
/* -------------------------------------------------------------------------- */

const classRouter = router({
  list: protectedProcedure
    .input(z.object({ cohortId: z.string().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const now = new Date()
      const rows = await ctx.db.webinarClass.findMany({
        where: { deletedAt: null, ...(input.cohortId ? { cohortId: input.cohortId } : {}) },
        orderBy: [{ subject: 'asc' }, { level: 'asc' }],
        include: {
          cohort: { select: { name: true, status: true, startsOn: true, endsOn: true, holidays: true } },
          _count: { select: { enrollments: true } },
        },
      })
      return rows.map((cl) => {
        const sessions = computeSessions(
          cl.cohort.startsOn,
          cl.cohort.endsOn,
          cl.dayOfWeek,
          cl.cohort.holidays.map((h) => ({ startsOn: h.startsOn, endsOn: h.endsOn })),
        )
        const week = currentWeekInfo(sessions, now, cl.timezone)
        return {
          id: cl.id,
          cohortId: cl.cohortId,
          cohortName: cl.cohort.name,
          subject: cl.subject,
          subjectLabel: subjectLabel(cl.subject),
          level: cl.level,
          levelLabel: levelLabel(cl.level),
          title: cl.title,
          dayOfWeek: cl.dayOfWeek,
          dayLabel: WEEKDAY_LABEL[cl.dayOfWeek] ?? '—',
          startMinute: cl.startMinute,
          timezone: cl.timezone,
          zoomLink: cl.zoomLink,
          zoomLinkUpdatedAt: cl.zoomLinkUpdatedAt,
          zoomRotationDue: zoomRotationDue(cl.zoomLinkUpdatedAt, cl.zoomRotateEveryWeeks, now),
          active: cl.active,
          enrollmentCount: cl._count.enrollments,
          hasUploadedPdf: (cl.syllabusPdfByteSize ?? 0) > 0,
          weekState: week.state,
          currentWeekNumber: week.weekNumber,
          totalWeeks: week.totalWeeks,
        }
      })
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const cl = await ctx.db.webinarClass.findFirst({
      where: { id: input.id, deletedAt: null },
      include: {
        cohort: { include: { holidays: true } },
        syllabusWeeks: { orderBy: { weekNumber: 'asc' } },
      },
    })
    if (!cl) throw new TRPCError({ code: 'NOT_FOUND' })
    const sessions = computeSessions(
      cl.cohort.startsOn,
      cl.cohort.endsOn,
      cl.dayOfWeek,
      cl.cohort.holidays.map((h) => ({ startsOn: h.startsOn, endsOn: h.endsOn })),
    )
    const topics = new Map(cl.syllabusWeeks.map((w) => [w.weekNumber, w.topic]))
    const schedule = sessions.map((s) => ({
      weekNumber: s.weekNumber,
      dateLabel: formatSessionDateShort(
        sessionStartInstant(s, cl.startMinute, cl.timezone),
        cl.timezone,
      ),
      timeLabel: formatSessionTime(sessionStartInstant(s, cl.startMinute, cl.timezone), cl.timezone),
      topic: topics.get(s.weekNumber) ?? '',
    }))
    const week = currentWeekInfo(sessions, new Date(), cl.timezone)
    const currentWeek = {
      state: week.state,
      weekNumber: week.weekNumber,
      totalWeeks: week.totalWeeks,
      dateLabel: week.date
        ? formatSessionDateShort(
            sessionStartInstant({ weekNumber: week.weekNumber ?? 0, date: week.date }, cl.startMinute, cl.timezone),
            cl.timezone,
          )
        : null,
      timeLabel: week.date
        ? formatSessionTime(
            sessionStartInstant({ weekNumber: week.weekNumber ?? 0, date: week.date }, cl.startMinute, cl.timezone),
            cl.timezone,
          )
        : null,
      topic: week.weekNumber != null ? (topics.get(week.weekNumber) ?? '') : '',
    }
    return {
      id: cl.id,
      cohortId: cl.cohortId,
      cohortName: cl.cohort.name,
      currentWeek,
      subject: cl.subject,
      subjectLabel: subjectLabel(cl.subject),
      level: cl.level,
      levelLabel: levelLabel(cl.level),
      title: cl.title,
      dayOfWeek: cl.dayOfWeek,
      startMinute: cl.startMinute,
      durationMins: cl.durationMins,
      timezone: cl.timezone,
      zoomLink: cl.zoomLink,
      zoomLinkUpdatedAt: cl.zoomLinkUpdatedAt,
      zoomRotateEveryWeeks: cl.zoomRotateEveryWeeks,
      sendDaysOfWeek: cl.sendDaysOfWeek,
      sendHourLocal: cl.sendHourLocal,
      emailSubjectTemplate: cl.emailSubjectTemplate,
      emailBodyTemplate: cl.emailBodyTemplate,
      active: cl.active,
      hasUploadedPdf: (cl.syllabusPdfByteSize ?? 0) > 0,
      uploadedPdfFileName: cl.syllabusPdfFileName,
      sessionCount: sessions.length,
      schedule,
    }
  }),

  create: auditedProcedure
    .input(
      z.object({
        cohortId: z.string(),
        subject: webinarSubjectSchema,
        level: webinarLevelSchema,
        title: z.string().trim().min(1).max(120),
        dayOfWeek: z.number().int().min(0).max(6),
        startMinute: z.number().int().min(0).max(1439),
        durationMins: z.number().int().min(15).max(480).default(60),
        timezone: z.string().trim().min(1).max(64).default('Europe/London'),
        zoomLink: z.string().trim().url().max(500).optional(),
        sendDaysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([0, 1]),
        sendHourLocal: z.number().int().min(0).max(23).default(9),
        zoomRotateEveryWeeks: z.number().int().min(0).max(52).default(4),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const id = createId()
      try {
        await ctx.db.webinarClass.create({
          data: {
            id,
            cohortId: input.cohortId,
            subject: input.subject,
            level: input.level,
            title: input.title,
            dayOfWeek: input.dayOfWeek,
            startMinute: input.startMinute,
            durationMins: input.durationMins,
            timezone: input.timezone,
            zoomLink: input.zoomLink ?? null,
            zoomLinkUpdatedAt: input.zoomLink ? new Date() : null,
            sendDaysOfWeek: [...new Set(input.sendDaysOfWeek)].sort(),
            sendHourLocal: input.sendHourLocal,
            zoomRotateEveryWeeks: input.zoomRotateEveryWeeks,
            createdById: user.id,
            updatedById: user.id,
          },
        })
      } catch (err) {
        if (err instanceof Error && /Unique/i.test(err.message)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That subject + level already exists in this cohort.',
          })
        }
        throw err
      }
      await ctx.audit({
        action: 'webinar.class_created',
        target: { type: 'WebinarClass', id },
        after: { subject: input.subject, level: input.level, title: input.title },
      })

      // Auto-generate the Zoom meeting when the operator has opted in and a Zoom
      // app is configured (best effort — never fails class creation).
      let zoomGenerated = false
      if (!input.zoomLink && zoomClient.isConfigured()) {
        const settings = await ctx.db.webinarSettings.findUnique({
          where: { id: 'webinar' },
          select: { zoomAutoCreate: true, zoomHostEmail: true },
        })
        if (settings?.zoomAutoCreate) {
          try {
            const cohort = await ctx.db.webinarCohort.findUnique({
              where: { id: input.cohortId },
              select: { name: true },
            })
            const meeting = await zoomClient.createRecurringMeeting({
              hostEmail: settings.zoomHostEmail || undefined,
              topic: `${subjectLabel(input.subject)} ${levelLabel(input.level)} — ${cohort?.name ?? ''}`,
              timezone: input.timezone,
            })
            await ctx.db.webinarClass.update({
              where: { id },
              data: {
                zoomLink: meeting.join_url,
                zoomMeetingId: String(meeting.id),
                zoomHostEmail: settings.zoomHostEmail || null,
                zoomLinkUpdatedAt: new Date(),
              },
            })
            await ctx.audit({
              action: 'webinar.zoom_meeting_created',
              target: { type: 'WebinarClass', id },
              after: { zoomMeetingId: String(meeting.id), auto: true },
            })
            zoomGenerated = true
          } catch {
            // Leave the class without a link; staff can generate it manually.
          }
        }
      }
      return { id, zoomGenerated }
    }),

  update: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().trim().min(1).max(120).optional(),
        dayOfWeek: z.number().int().min(0).max(6).optional(),
        startMinute: z.number().int().min(0).max(1439).optional(),
        durationMins: z.number().int().min(15).max(480).optional(),
        timezone: z.string().trim().min(1).max(64).optional(),
        sendDaysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        sendHourLocal: z.number().int().min(0).max(23).optional(),
        zoomRotateEveryWeeks: z.number().int().min(0).max(52).optional(),
        emailSubjectTemplate: z.string().trim().max(300).nullish(),
        emailBodyTemplate: z.string().trim().max(8000).nullish(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const { id, sendDaysOfWeek, ...rest } = input
      const before = await ctx.db.webinarClass.findUnique({
        where: { id },
        select: { title: true, active: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.webinarClass.update({
        where: { id },
        data: {
          ...rest,
          ...(sendDaysOfWeek !== undefined
            ? { sendDaysOfWeek: [...new Set(sendDaysOfWeek)].sort() }
            : {}),
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'webinar.class_updated',
        target: { type: 'WebinarClass', id },
        before,
        after: rest,
      })
      return { id }
    }),

  setZoomLink: auditedProcedure
    .input(z.object({ id: z.string(), zoomLink: z.string().trim().url().max(500) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.webinarClass.findUnique({
        where: { id: input.id },
        select: { zoomLink: true, title: true, subject: true, level: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.webinarClass.update({
        where: { id: input.id },
        data: { zoomLink: input.zoomLink, zoomLinkUpdatedAt: new Date(), updatedById: user.id },
      })
      // Close any open rotation reminder for this class.
      const title = `[Webinar] Update Zoom link — ${subjectLabel(before.subject)} ${levelLabel(
        before.level,
      )}`
      await ctx.db.task.updateMany({
        where: { title, status: { in: ['open', 'in_progress'] } },
        data: { status: 'done' },
      })
      await ctx.audit({
        action: 'webinar.zoom_link_rotated',
        target: { type: 'WebinarClass', id: input.id },
        before: { zoomLink: before.zoomLink },
        after: { zoomLink: input.zoomLink },
      })
      return { id: input.id }
    }),

  /**
   * Generate a Zoom meeting for the class via the Zoom integration (ADR 0035):
   * a recurring meeting open to all (join-before-host, no registration) with
   * cloud auto-recording. Stores the join link + meeting id and clears the
   * rotation reminder. Requires the Zoom Server-to-Server app to be configured.
   */
  generateZoomLink: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      if (!zoomClient.isConfigured()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Zoom is not connected. Add the Server-to-Server credentials first.',
        })
      }
      const cls = await ctx.db.webinarClass.findFirst({
        where: { id: input.id, deletedAt: null },
        include: { cohort: { select: { name: true } } },
      })
      if (!cls) throw new TRPCError({ code: 'NOT_FOUND' })
      const settings = await ctx.db.webinarSettings.findUnique({
        where: { id: 'webinar' },
        select: { zoomHostEmail: true },
      })
      const host = cls.zoomHostEmail || settings?.zoomHostEmail || undefined
      const topic = `${subjectLabel(cls.subject)} ${levelLabel(cls.level)} — ${cls.cohort.name}`
      let meeting
      try {
        meeting = await zoomClient.createRecurringMeeting({
          hostEmail: host,
          topic,
          timezone: cls.timezone,
        })
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? `Zoom: ${err.message}` : 'Zoom meeting creation failed',
        })
      }
      // Regenerating: delete the OLD meeting so its join link stops working
      // (the whole point of rotation — a lapsed member can't reuse it).
      if (cls.zoomMeetingId && cls.zoomMeetingId !== String(meeting.id)) {
        try {
          await zoomClient.deleteMeeting(cls.zoomMeetingId)
          await ctx.audit({
            action: 'webinar.zoom_meeting_deleted',
            target: { type: 'WebinarClass', id: input.id },
            before: { zoomMeetingId: cls.zoomMeetingId },
          })
        } catch {
          // Best effort — the new link is already live.
        }
      }
      await ctx.db.webinarClass.update({
        where: { id: input.id },
        data: {
          zoomLink: meeting.join_url,
          zoomMeetingId: String(meeting.id),
          zoomHostEmail: host ?? null,
          zoomLinkUpdatedAt: new Date(),
          updatedById: user.id,
        },
      })
      const taskTitle = `[Webinar] Update Zoom link — ${subjectLabel(cls.subject)} ${levelLabel(cls.level)}`
      await ctx.db.task.updateMany({
        where: { title: taskTitle, status: { in: ['open', 'in_progress'] } },
        data: { status: 'done' },
      })
      await ctx.audit({
        action: 'webinar.zoom_meeting_created',
        target: { type: 'WebinarClass', id: input.id },
        after: { zoomMeetingId: String(meeting.id) },
      })
      return { id: input.id, joinUrl: meeting.join_url }
    }),

  /** Manually email this class's latest Zoom recording to the active list now. */
  sendRecordingNow: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const result = await sendRecordingsForClassId(ctx.db, input.id, ctx.requestId, { force: true })
      return result
    }),

  /**
   * One-off broadcast to everyone on a class's mailing list — e.g. to announce a
   * time change. Email goes via the system mailbox; whatsapp/sms start a Trengo
   * conversation per contact under the acting agent's token. Best-effort per
   * recipient. `{{first_name}}` is substituted.
   */
  broadcast: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        channel: z.enum(['email', 'whatsapp', 'sms']),
        subject: z.string().trim().max(200).optional(),
        body: z.string().trim().min(1).max(5000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const cls = await ctx.db.webinarClass.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, subject: true, level: true },
      })
      if (!cls) throw new TRPCError({ code: 'NOT_FOUND' })
      const settings = await ctx.db.webinarSettings.findUnique({
        where: { id: 'webinar' },
        select: { senderMailboxUserId: true },
      })
      const enrollments = await ctx.db.webinarEnrollment.findMany({
        where: { classId: cls.id, status: 'active', deletedAt: null },
        include: { contact: { select: { id: true, firstName: true, email: true, phoneE164: true } } },
      })

      let sent = 0
      let failed = 0
      let skipped = 0
      const fallbackSubject = `Update — ${subjectLabel(cls.subject)} ${levelLabel(cls.level)}`
      for (const e of enrollments) {
        const c = e.contact
        const body = input.body.replace(/\{\{\s*first_name\s*\}\}/gi, c.firstName || 'there')
        try {
          if (input.channel === 'email') {
            if (!c.email) {
              skipped += 1
              continue
            }
            const r = await sendSystemEmail({
              to: c.email,
              subject: input.subject || fallbackSubject,
              text: body,
              fromAgentId: settings?.senderMailboxUserId ?? undefined,
              requestId: `${ctx.requestId}:${c.id}`,
            })
            if (r.status === 'sent') sent += 1
            else failed += 1
          } else {
            if (!c.phoneE164) {
              skipped += 1
              continue
            }
            await trengoOutbound.startConversation({
              contactId: c.id,
              agentId: user.id,
              channel: input.channel,
              recipient: c.phoneE164,
              body,
              requestId: `${ctx.requestId}:${c.id}`,
            })
            sent += 1
          }
        } catch {
          failed += 1
        }
      }
      await ctx.audit({
        action: 'webinar.broadcast_sent',
        target: { type: 'WebinarClass', id: cls.id },
        after: { channel: input.channel, sent, failed, skipped },
      })
      return { sent, failed, skipped }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.webinarClass.findUnique({
        where: { id: input.id },
        select: { title: true, deletedAt: true, zoomMeetingId: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.webinarClass.update({
        where: { id: input.id },
        data: { deletedAt: new Date(), active: false, updatedById: user.id },
      })
      // Clean up the Zoom meeting so its link dies with the class.
      if (before.zoomMeetingId && zoomClient.isConfigured()) {
        try {
          await zoomClient.deleteMeeting(before.zoomMeetingId)
        } catch {
          // Best effort.
        }
      }
      await ctx.audit({
        action: 'webinar.class_archived',
        target: { type: 'WebinarClass', id: input.id },
        before,
      })
      return { id: input.id }
    }),

  uploadSyllabusPdf: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        fileName: z.string().trim().min(1).max(255),
        dataBase64: z.string().min(1).max(12_000_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const cls = await ctx.db.webinarClass.findUnique({
        where: { id: input.id },
        select: { id: true },
      })
      if (!cls) throw new TRPCError({ code: 'NOT_FOUND' })
      const data = Buffer.from(input.dataBase64, 'base64')
      if (data.byteLength === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'File is empty.' })
      if (data.byteLength > MAX_PDF_BYTES) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'PDF must be 8 MB or smaller.' })
      }
      if (data.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'File is not a PDF.' })
      }
      await ctx.db.webinarClass.update({
        where: { id: input.id },
        data: {
          syllabusPdfData: data,
          syllabusPdfFileName: input.fileName,
          syllabusPdfContentType: 'application/pdf',
          syllabusPdfByteSize: data.byteLength,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'webinar.syllabus_pdf_uploaded',
        target: { type: 'WebinarClass', id: input.id },
        after: { fileName: input.fileName, byteSize: data.byteLength },
      })
      return { id: input.id, byteSize: data.byteLength }
    }),

  removeSyllabusPdf: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      await ctx.db.webinarClass.update({
        where: { id: input.id },
        data: {
          syllabusPdfData: null,
          syllabusPdfFileName: null,
          syllabusPdfContentType: null,
          syllabusPdfByteSize: null,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'webinar.syllabus_pdf_removed',
        target: { type: 'WebinarClass', id: input.id },
      })
      return { id: input.id }
    }),
})

/* -------------------------------------------------------------------------- */
/* Syllabus                                                                    */
/* -------------------------------------------------------------------------- */

const syllabusRouter = router({
  set: auditedProcedure
    .input(
      z.object({
        classId: z.string(),
        weeks: z
          .array(
            z.object({
              weekNumber: z.number().int().min(1).max(60),
              topic: z.string().trim().min(1).max(300),
              notes: z.string().trim().max(2000).optional(),
            }),
          )
          .max(60),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      await ctx.db.$transaction([
        ctx.db.webinarSyllabusWeek.deleteMany({ where: { classId: input.classId } }),
        ctx.db.webinarSyllabusWeek.createMany({
          data: input.weeks.map((w) => ({
            id: createId(),
            classId: input.classId,
            weekNumber: w.weekNumber,
            topic: w.topic,
            notes: w.notes ?? null,
            createdById: user.id,
            updatedById: user.id,
          })),
        }),
      ])
      await ctx.audit({
        action: 'webinar.syllabus_set',
        target: { type: 'WebinarClass', id: input.classId },
        after: { weeks: input.weeks.length },
      })
      return { count: input.weeks.length }
    }),

  /** Auto-generate placeholder weeks for every computed session. */
  generate: auditedProcedure
    .input(z.object({ classId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const cl = await ctx.db.webinarClass.findFirst({
        where: { id: input.classId, deletedAt: null },
        include: { cohort: { include: { holidays: true } } },
      })
      if (!cl) throw new TRPCError({ code: 'NOT_FOUND' })
      const sessions = computeSessions(
        cl.cohort.startsOn,
        cl.cohort.endsOn,
        cl.dayOfWeek,
        cl.cohort.holidays.map((h) => ({ startsOn: h.startsOn, endsOn: h.endsOn })),
      )
      await ctx.db.$transaction([
        ctx.db.webinarSyllabusWeek.deleteMany({ where: { classId: input.classId } }),
        ctx.db.webinarSyllabusWeek.createMany({
          data: sessions.map((s) => ({
            id: createId(),
            classId: input.classId,
            weekNumber: s.weekNumber,
            topic: `Week ${s.weekNumber} — topic to be confirmed`,
            createdById: user.id,
            updatedById: user.id,
          })),
        }),
      ])
      await ctx.audit({
        action: 'webinar.syllabus_generated',
        target: { type: 'WebinarClass', id: input.classId },
        after: { weeks: sessions.length },
      })
      return { count: sessions.length }
    }),

  /**
   * Import a schedule from an uploaded CSV / PDF / pasted text. Uses AI to
   * structure the (often messy) text into weekly topics, with a deterministic
   * fallback. Returns a PREVIEW only — the human confirms and `syllabus.set`
   * saves it (CLAUDE.md §3). Not audited: reads + AI only, writes nothing.
   */
  importPreview: protectedProcedure
    .input(
      z.object({
        classId: z.string(),
        kind: z.enum(['pdf', 'csv', 'text']),
        dataBase64: z.string().max(16_000_000).optional(),
        text: z.string().max(60_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const cl = await ctx.db.webinarClass.findFirst({
        where: { id: input.classId, deletedAt: null },
        include: { cohort: { include: { holidays: true } } },
      })
      if (!cl) throw new TRPCError({ code: 'NOT_FOUND' })
      const totalWeeks = computeSessions(
        cl.cohort.startsOn,
        cl.cohort.endsOn,
        cl.dayOfWeek,
        cl.cohort.holidays.map((h) => ({ startsOn: h.startsOn, endsOn: h.endsOn })),
      ).length

      const text = importToText(input.kind as ImportKind, {
        base64: input.dataBase64,
        text: input.text,
      })
      if (text.trim().length === 0) {
        return {
          weeks: [] as Array<{ weekNumber: number; topic: string }>,
          note:
            input.kind === 'pdf'
              ? 'Could not read text from that PDF (it may be scanned). Paste the schedule or upload a CSV instead.'
              : 'No text found to import.',
          source: 'none' as const,
        }
      }

      // AI-structure first; fall back to a deterministic parse on any failure
      // (budget exhausted, provider error, empty result).
      try {
        const prompt = buildScheduleImportPrompt({ text, totalWeeks: totalWeeks || 52 })
        const out = await runStructured({
          task: 'webinar_schedule_import',
          promptVersion: WEBINAR_SCHEDULE_IMPORT_PROMPT_VERSION,
          schema: scheduleImportSchema,
          system: prompt.system,
          user: prompt.user,
          model: 'gpt-4o-mini',
          ctx: { requestId: ctx.requestId, source: 'webinar.import' },
        })
        if (out.weeks.length > 0) {
          return { weeks: out.weeks, note: out.note || 'Parsed with AI.', source: 'ai' as const }
        }
      } catch {
        // fall through to deterministic parse
      }
      const fallback = parseScheduleFallback(text, totalWeeks || 52)
      return {
        weeks: fallback,
        note:
          fallback.length > 0
            ? 'Parsed without AI (rule-based). Please check the weeks below.'
            : 'Could not parse a schedule from that input.',
        source: 'fallback' as const,
      }
    }),
})

/* -------------------------------------------------------------------------- */
/* Enrolments                                                                  */
/* -------------------------------------------------------------------------- */

const ENROLLMENT_STATUSES = ['pending_review', 'active', 'paused', 'expired', 'cancelled'] as const

const enrollmentRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          classId: z.string().optional(),
          status: z.enum(ENROLLMENT_STATUSES).optional(),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.webinarEnrollment.findMany({
        where: {
          deletedAt: null,
          ...(input.classId ? { classId: input.classId } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        include: {
          contact: { select: { id: true, firstName: true, lastName: true, email: true } },
          webinarClass: { select: { subject: true, level: true, title: true } },
        },
      })
      return rows.map((e) => ({
        id: e.id,
        status: e.status,
        source: e.source,
        matchConfidence: e.matchConfidence,
        matchReason: e.matchReason,
        expiresAt: e.expiresAt,
        billingInterval: e.billingInterval,
        classId: e.classId,
        classLabel: `${subjectLabel(e.webinarClass.subject)} ${levelLabel(
          e.webinarClass.level,
        )}`,
        contactId: e.contact.id,
        contactName:
          [e.contact.firstName, e.contact.lastName].filter(Boolean).join(' ') || '(no name)',
        contactEmail: e.contact.email,
      }))
    }),

  setStatus: auditedProcedure
    .input(z.object({ id: z.string(), status: z.enum(ENROLLMENT_STATUSES) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.webinarEnrollment.findUnique({
        where: { id: input.id },
        select: { status: true, classId: true, contactId: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.webinarEnrollment.update({
        where: { id: input.id },
        data: {
          status: input.status,
          enrolledAt: input.status === 'active' ? new Date() : undefined,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'webinar.enrollment_status_changed',
        target: { type: 'WebinarEnrollment', id: input.id },
        before,
        after: { status: input.status },
      })
      return { id: input.id }
    }),

  create: auditedProcedure
    .input(
      z.object({
        classId: z.string(),
        contactId: z.string(),
        status: z.enum(['active', 'pending_review']).default('active'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const id = createId()
      try {
        await ctx.db.webinarEnrollment.create({
          data: {
            id,
            classId: input.classId,
            contactId: input.contactId,
            status: input.status,
            source: 'manual',
            enrolledAt: input.status === 'active' ? new Date() : null,
            createdById: user.id,
            updatedById: user.id,
          },
        })
      } catch (err) {
        if (err instanceof Error && /Unique/i.test(err.message)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That contact is already enrolled in this class.',
          })
        }
        throw err
      }
      await ctx.audit({
        action: 'webinar.enrollment_created',
        target: { type: 'WebinarEnrollment', id },
        after: { classId: input.classId, contactId: input.contactId, status: input.status },
      })
      return { id }
    }),

  remove: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      await ctx.db.webinarEnrollment.update({
        where: { id: input.id },
        data: { status: 'cancelled', deletedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: 'webinar.enrollment_removed',
        target: { type: 'WebinarEnrollment', id: input.id },
      })
      return { id: input.id }
    }),

  /** Typeahead for manually adding a contact to a class's mailing list. */
  contactSearch: protectedProcedure
    .input(z.object({ term: z.string().trim().min(1).max(120) }))
    .query(async ({ ctx, input }) => {
      const term = input.term
      const rows = await ctx.db.contact.findMany({
        where: {
          deletedAt: null,
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { firstName: { contains: term, mode: 'insensitive' } },
            { lastName: { contains: term, mode: 'insensitive' } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { id: true, firstName: true, lastName: true, email: true },
      })
      return rows.map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)',
        email: c.email,
      }))
    }),

  /** Scan Stripe and organise weekly-class payers into classes. */
  detectFromStripe: auditedProcedure
    .input(z.object({ useAi: z.boolean().default(true) }).default({}))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const result = await detectEnrollmentsFromStripe(ctx.db, {
        actorId: user.id,
        requestId: ctx.requestId,
        useAi: input.useAi,
      })
      await ctx.audit({
        action: 'webinar.detect_run',
        target: { type: 'WebinarSettings', id: 'webinar' },
        after: {
          cohort: result.cohort,
          scanned: result.scanned,
          matched: result.matched,
          autoEnrolled: result.autoEnrolled,
          pendingReview: result.pendingReview,
        },
      })
      return result
    }),
})

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

const settingsRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.webinarSettings.findUnique({ where: { id: 'webinar' } })
    return {
      senderMailboxUserId: row?.senderMailboxUserId ?? null,
      defaultSendDaysOfWeek: row?.defaultSendDaysOfWeek ?? [0, 1],
      defaultSendHourLocal: row?.defaultSendHourLocal ?? 9,
      defaultZoomRotateEveryWeeks: row?.defaultZoomRotateEveryWeeks ?? 4,
      emailSubjectTemplate: row?.emailSubjectTemplate ?? '',
      emailBodyTemplate: row?.emailBodyTemplate ?? '',
      fromName: row?.fromName ?? '',
      // Zoom integration (ADR 0035).
      zoomConnected: zoomClient.isConfigured(),
      zoomAutoCreate: row?.zoomAutoCreate ?? false,
      zoomSendRecordings: row?.zoomSendRecordings ?? false,
      zoomTrashAfterSend: row?.zoomTrashAfterSend ?? false,
      zoomHostEmail: row?.zoomHostEmail ?? '',
    }
  }),

  update: auditedProcedure
    .input(
      z.object({
        senderMailboxUserId: z.string().nullish(),
        defaultSendDaysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        defaultSendHourLocal: z.number().int().min(0).max(23).optional(),
        defaultZoomRotateEveryWeeks: z.number().int().min(0).max(52).optional(),
        emailSubjectTemplate: z.string().trim().max(300).optional(),
        emailBodyTemplate: z.string().trim().max(8000).optional(),
        fromName: z.string().trim().max(120).optional(),
        zoomAutoCreate: z.boolean().optional(),
        zoomSendRecordings: z.boolean().optional(),
        zoomTrashAfterSend: z.boolean().optional(),
        zoomHostEmail: z.string().trim().max(160).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const sendDays =
        input.defaultSendDaysOfWeek !== undefined
          ? [...new Set(input.defaultSendDaysOfWeek)].sort()
          : undefined
      await ctx.db.webinarSettings.upsert({
        where: { id: 'webinar' },
        create: {
          id: 'webinar',
          senderMailboxUserId: input.senderMailboxUserId ?? null,
          defaultSendDaysOfWeek: sendDays ?? [0, 1],
          defaultSendHourLocal: input.defaultSendHourLocal ?? 9,
          defaultZoomRotateEveryWeeks: input.defaultZoomRotateEveryWeeks ?? 4,
          emailSubjectTemplate: input.emailSubjectTemplate ?? '',
          emailBodyTemplate: input.emailBodyTemplate ?? '',
          fromName: input.fromName ?? null,
          zoomAutoCreate: input.zoomAutoCreate ?? false,
          zoomSendRecordings: input.zoomSendRecordings ?? false,
          zoomTrashAfterSend: input.zoomTrashAfterSend ?? false,
          zoomHostEmail: input.zoomHostEmail ?? null,
          createdById: user.id,
          updatedById: user.id,
        },
        update: {
          ...(input.senderMailboxUserId !== undefined
            ? { senderMailboxUserId: input.senderMailboxUserId }
            : {}),
          ...(sendDays !== undefined ? { defaultSendDaysOfWeek: sendDays } : {}),
          ...(input.defaultSendHourLocal !== undefined
            ? { defaultSendHourLocal: input.defaultSendHourLocal }
            : {}),
          ...(input.defaultZoomRotateEveryWeeks !== undefined
            ? { defaultZoomRotateEveryWeeks: input.defaultZoomRotateEveryWeeks }
            : {}),
          ...(input.emailSubjectTemplate !== undefined
            ? { emailSubjectTemplate: input.emailSubjectTemplate }
            : {}),
          ...(input.emailBodyTemplate !== undefined
            ? { emailBodyTemplate: input.emailBodyTemplate }
            : {}),
          ...(input.fromName !== undefined ? { fromName: input.fromName } : {}),
          ...(input.zoomAutoCreate !== undefined ? { zoomAutoCreate: input.zoomAutoCreate } : {}),
          ...(input.zoomSendRecordings !== undefined
            ? { zoomSendRecordings: input.zoomSendRecordings }
            : {}),
          ...(input.zoomTrashAfterSend !== undefined
            ? { zoomTrashAfterSend: input.zoomTrashAfterSend }
            : {}),
          ...(input.zoomHostEmail !== undefined ? { zoomHostEmail: input.zoomHostEmail } : {}),
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'webinar.settings_updated',
        target: { type: 'WebinarSettings', id: 'webinar' },
        after: { fromName: input.fromName },
      })
      return { ok: true }
    }),
})

/* -------------------------------------------------------------------------- */
/* Zoom                                                                        */
/* -------------------------------------------------------------------------- */

const zoomRouter = router({
  /** Verify the configured Zoom credentials by fetching the connected user. */
  testConnection: protectedProcedure.mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    if (!zoomClient.isConfigured()) {
      return { ok: false as const, error: 'Zoom credentials are not set.' }
    }
    try {
      const me = await zoomClient.getMe()
      return { ok: true as const, email: me.email }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'Zoom request failed' }
    }
  }),
})

/* -------------------------------------------------------------------------- */
/* Overview                                                                    */
/* -------------------------------------------------------------------------- */

export const webinarRouter = router({
  overview: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date()
    const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    const [activeCohort, classes, activeEnrollments, pendingReview, expiringSoon, recentDispatches] =
      await Promise.all([
        ctx.db.webinarCohort.findFirst({
          where: { status: 'active', deletedAt: null },
          orderBy: { startsOn: 'desc' },
          select: { id: true, name: true },
        }),
        ctx.db.webinarClass.findMany({
          where: { active: true, deletedAt: null, cohort: { status: 'active' } },
          select: {
            zoomLinkUpdatedAt: true,
            zoomRotateEveryWeeks: true,
            dayOfWeek: true,
            timezone: true,
            cohort: { select: { startsOn: true, endsOn: true, holidays: true } },
          },
        }),
        ctx.db.webinarEnrollment.count({ where: { status: 'active', deletedAt: null } }),
        ctx.db.webinarEnrollment.count({ where: { status: 'pending_review', deletedAt: null } }),
        ctx.db.webinarEnrollment.count({
          where: { status: 'active', deletedAt: null, expiresAt: { gte: now, lte: soon } },
        }),
        ctx.db.webinarEmailDispatch.count({
          where: { status: 'sent', sentAt: { gte: new Date(now.getTime() - 7 * 864e5) } },
        }),
      ])
    const zoomDue = classes.filter((c) =>
      zoomRotationDue(c.zoomLinkUpdatedAt, c.zoomRotateEveryWeeks, now),
    ).length
    const sessionsThisWeek = classes.filter((c) => {
      const sessions = computeSessions(
        c.cohort.startsOn,
        c.cohort.endsOn,
        c.dayOfWeek,
        c.cohort.holidays.map((h) => ({ startsOn: h.startsOn, endsOn: h.endsOn })),
      )
      return currentWeekInfo(sessions, now, c.timezone).state === 'in_week'
    }).length
    return {
      activeCohort,
      classCount: classes.length,
      activeEnrollments,
      pendingReview,
      expiringSoon,
      zoomRotationDue: zoomDue,
      sessionsThisWeek,
      emailsSentLast7Days: recentDispatches,
      autoEnrollThreshold: AUTO_ENROLL_CONFIDENCE,
    }
  }),

  cohort: cohortRouter,
  class: classRouter,
  syllabus: syllabusRouter,
  enrollment: enrollmentRouter,
  settings: settingsRouter,
  subject: webinarSubjectRouter,
  level: webinarLevelRouter,
  zoom: zoomRouter,
})
