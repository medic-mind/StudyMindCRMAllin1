// LA progress report generation + signoff. CLAUDE.md §43.3.
//
// Monthly progress reports are required by most LA contracts. The CRM
// generates a draft from delivered sessions, attendance %, tutor notes, and
// closed safeguarding flags during the period. The account lead edits and
// signs off; signed reports lock for editing and become eligible for PDF
// export to S3.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'

type DbWriter = PrismaClient | Prisma.TransactionClient

export interface ActorCtx {
  actorId: string
  requestId: string
}

export interface SessionDeliverySummary {
  sessionId: string
  scheduledAt: string
  state: 'delivered' | 'no_show' | 'cancelled' | 'tentative' | 'confirmed'
  hours: number
}

export interface ReportRunner {
  (input: {
    laName: string
    contractReference: string
    learnerInitials: string
    periodStart: string
    periodEnd: string
    sessions: ReadonlyArray<SessionDeliverySummary>
    tutorNotes: ReadonlyArray<string>
    safeguardingClosures: ReadonlyArray<{ flagId: string; closedAt: string; summary: string }>
    paymentStatus: 'on_track' | 'overdue' | 'paid'
  }): Promise<{ text: string; promptVersion: string }>
}

export interface GenerateProgressReportInput {
  contractId: string
  learnerFamilyId: string
  periodStart: Date
  periodEnd: Date
}

export interface GenerateProgressReportResult {
  reportId: string
  draftText: string
  promptVersion: string
}

/**
 * Build a draft progress report and persist it. Refuses if a report for the
 * same (contract, family, period) already exists in non-rejected state.
 */
export async function generateProgressReportDraft(
  db: DbWriter,
  input: GenerateProgressReportInput,
  ctx: ActorCtx,
  runner: ReportRunner,
): Promise<GenerateProgressReportResult> {
  const contract = await db.lAContract.findUniqueOrThrow({
    where: { id: input.contractId },
    select: { id: true, laName: true, reference: true },
  })

  const existing = await db.lAProgressReport.findUnique({
    where: {
      contractId_familyId_periodStart_periodEnd: {
        contractId: input.contractId,
        familyId: input.learnerFamilyId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      },
    },
    select: { id: true, state: true },
  })
  if (existing && existing.state !== 'rejected') {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `A ${existing.state} progress report already exists for this period`,
      { reportId: existing.id },
    )
  }

  // Collect signal: delivered sessions in period + tutor notes + closed flags.
  const sessions = (await db.bookingSession.findMany({
    where: {
      booking: { familyId: input.learnerFamilyId, deletedAt: null },
      deletedAt: null,
      scheduledAt: { gte: input.periodStart, lte: input.periodEnd },
    },
    select: { id: true, scheduledAt: true, state: true, hours: true, deliveredHours: true },
  })) as Array<{
    id: string
    scheduledAt: Date
    state: string
    hours: number
    deliveredHours: number
  }>

  const tutorInteractions = (await db.interaction.findMany({
    where: {
      familyId: input.learnerFamilyId,
      type: 'tutor_session_note',
      occurredAt: { gte: input.periodStart, lte: input.periodEnd },
      deletedAt: null,
    },
    select: { summary: true },
    orderBy: { occurredAt: 'desc' },
    take: 30,
  })) as Array<{ summary: string | null }>

  const tutorNotes = tutorInteractions
    .map((i) => i.summary)
    .filter((s): s is string => Boolean(s))

  const closures = (await db.safeguardingFlag.findMany({
    where: {
      contact: { familyMembers: { some: { familyId: input.learnerFamilyId } } },
      closedAt: { gte: input.periodStart, lte: input.periodEnd },
    },
    select: { id: true, closedAt: true },
  })) as Array<{ id: string; closedAt: Date | null }>

  const sessionSummaries: SessionDeliverySummary[] = sessions.map((s) => ({
    sessionId: s.id,
    scheduledAt: s.scheduledAt.toISOString(),
    state: s.state as SessionDeliverySummary['state'],
    hours: s.deliveredHours || s.hours,
  }))

  const result = await runner({
    laName: contract.laName,
    contractReference: contract.reference,
    learnerInitials: input.learnerFamilyId.slice(0, 4).toUpperCase(),
    periodStart: input.periodStart.toISOString().slice(0, 10),
    periodEnd: input.periodEnd.toISOString().slice(0, 10),
    sessions: sessionSummaries,
    tutorNotes,
    safeguardingClosures: closures.map((c) => ({
      flagId: c.id,
      closedAt: c.closedAt?.toISOString() ?? '',
      summary: 'Safeguarding flag closed (details encrypted).',
    })),
    paymentStatus: 'on_track',
  })

  const reportId = createId()
  await db.lAProgressReport.create({
    data: {
      id: reportId,
      contractId: input.contractId,
      familyId: input.learnerFamilyId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      draftText: result.text,
      promptVersion: result.promptVersion,
      state: 'draft',
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'lacontract.progress_report_drafted',
    target: { type: 'LAProgressReport', id: reportId },
    requestId: ctx.requestId,
    after: {
      contractId: input.contractId,
      familyId: input.learnerFamilyId,
      promptVersion: result.promptVersion,
    },
  })

  return { reportId, draftText: result.text, promptVersion: result.promptVersion }
}

export interface SignoffProgressReportInput {
  reportId: string
  signerId: string
  decision: 'approve' | 'reject'
  rationale?: string
}

/**
 * Sign off a draft progress report. Only `account_lead` (or `admin`) callers
 * are permitted by the tRPC procedure; this domain function validates state.
 * Approved reports lock for editing.
 */
export async function signoffProgressReport(
  db: DbWriter,
  input: SignoffProgressReportInput,
  ctx: ActorCtx,
): Promise<{ state: string }> {
  const report = await db.lAProgressReport.findUniqueOrThrow({
    where: { id: input.reportId },
    select: { id: true, state: true, contractId: true, familyId: true },
  })
  if (report.state !== 'draft') {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `Report ${input.reportId} is in state ${report.state}; only draft reports can be signed off`,
    )
  }

  const nextState = input.decision === 'approve' ? 'signed' : 'rejected'
  await db.lAProgressReport.update({
    where: { id: input.reportId },
    data: {
      state: nextState,
      signedById: input.decision === 'approve' ? input.signerId : null,
      signedAt: input.decision === 'approve' ? new Date() : null,
      updatedById: ctx.actorId,
    },
  })

  if (input.decision === 'approve') {
    await db.interaction.create({
      data: {
        id: createId(),
        type: 'lacontract_progress_report_signed',
        laContractId: report.contractId,
        familyId: report.familyId,
        occurredAt: new Date(),
        summary: 'Progress report signed off',
        payload: {
          event: 'lacontract.progress_report_signed',
          reportId: report.id,
          signerId: input.signerId,
        },
        createdById: ctx.actorId,
        updatedById: ctx.actorId,
      },
    })
  }

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'lacontract.progress_report_signed',
    target: { type: 'LAProgressReport', id: report.id },
    requestId: ctx.requestId,
    purpose: input.rationale,
    before: { state: 'draft' },
    after: { state: nextState, signerId: input.signerId },
  })

  return { state: nextState }
}
