// LAContract domain. CLAUDE.md §43.2-§43.4.
//
// On a tender award, an LAContract is created for the LA, one Family per
// learner placement (billingParty='local_authority'), and an optional
// retention-policy override is wired in. Stripe / GoCardless are not used
// for LA-billed Families — invariant enforced in invariants.ts and surfaced
// by the reconciliation engine.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'

type DbWriter = PrismaClient | Prisma.TransactionClient

export const LACONTRACT_DOMAIN = 'lacontract' as const

export type BillingCadence = 'monthly' | 'termly' | 'per_session'
export type ReportingCadence = 'monthly' | 'termly'

export interface LearnerPlacementInput {
  /** Provided when the learner Contact already exists; otherwise a new one
   *  is created from the supplied name fields. */
  contactId?: string
  firstName?: string
  lastName?: string
  dateOfBirth?: Date | null
  familyName?: string
  /** Optional AP Section-19 placement details. CLAUDE.md §43.4. */
  apPlacement?: {
    apStartDate: Date
    apReviewDate: Date
    apEndDate?: Date | null
    statutoryReason: string
  }
}

export interface CreateLAContractInput {
  tenderId: string
  reference: string
  laName: string
  commissioner?: string | null
  contractValueMinor: number
  startDate: Date
  endDate?: Date | null
  hoursEnvelope?: number | null
  billingCadence?: BillingCadence
  reportingCadence?: ReportingCadence
  accountLeadId: string
  retentionOverride?: {
    retentionDays: number
    notes?: string
  } | null
  learnerPlacements: ReadonlyArray<LearnerPlacementInput>
}

export interface ActorCtx {
  actorId: string
  requestId: string
}

export interface CreateLAContractResult {
  contractId: string
  familyIds: string[]
  retentionPolicyId: string | null
}

/**
 * Create an LAContract from an awarded tender, including learner-Family rows
 * (each with billingParty='local_authority') and an optional retention
 * override.
 *
 * Asserts the tender is in `awarded` state. The reconciliation engine takes
 * over from there to keep the no-card-subscription invariant honest.
 */
export async function createLAContractFromTender(
  db: DbWriter,
  input: CreateLAContractInput,
  ctx: ActorCtx,
): Promise<CreateLAContractResult> {
  const tender = await db.tender.findUniqueOrThrow({
    where: { id: input.tenderId },
    select: { id: true, state: true, isSemhOrEhcpHeavy: true },
  })

  if (tender.state !== 'awarded') {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `Cannot create LAContract: tender ${input.tenderId} is in state ${tender.state}, expected awarded`,
    )
  }

  const contractId = createId()

  // Retention override (CLAUDE.md §21, §43.2). Some LAs require longer
  // retention than the StudyMind defaults (e.g. 25 years from DOB for
  // safeguarding notes). The retention engine reads the override via the
  // contract → policy link.
  let retentionPolicyId: string | null = null
  if (input.retentionOverride) {
    retentionPolicyId = createId()
    await db.retentionPolicy.create({
      data: {
        id: retentionPolicyId,
        scope: `lacontract:${contractId}`,
        retentionDays: input.retentionOverride.retentionDays,
        contractId,
        notes: input.retentionOverride.notes ?? null,
        createdById: ctx.actorId,
        updatedById: ctx.actorId,
      },
    })
  }

  await db.lAContract.create({
    data: {
      id: contractId,
      tenderId: input.tenderId,
      laName: input.laName,
      commissioner: input.commissioner ?? null,
      reference: input.reference,
      contractValueMinor: input.contractValueMinor,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      hoursEnvelope: input.hoursEnvelope ?? null,
      billingCadence: input.billingCadence ?? 'monthly',
      reportingCadence: input.reportingCadence ?? 'monthly',
      accountLeadId: input.accountLeadId,
      retentionPolicyId,
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  // One Family per learner. billingParty='local_authority' rules out Stripe
  // and GoCardless paths via the reconciliation invariants.
  const familyIds: string[] = []
  for (const learner of input.learnerPlacements) {
    const familyId = createId()
    let contactId = learner.contactId
    if (!contactId) {
      contactId = createId()
      await db.contact.create({
        data: {
          id: contactId,
          kind: 'student',
          firstName: learner.firstName ?? null,
          lastName: learner.lastName ?? null,
          dateOfBirth: learner.dateOfBirth ?? null,
          isMinor: learner.dateOfBirth
            ? Date.now() - learner.dateOfBirth.getTime() < 18 * 365.25 * 24 * 60 * 60 * 1000
            : true,
          createdById: ctx.actorId,
          updatedById: ctx.actorId,
        },
      })
    }
    await db.family.create({
      data: {
        id: familyId,
        name: learner.familyName ?? `${learner.firstName ?? 'Learner'} ${learner.lastName ?? ''}`.trim(),
        state: 'active',
        billingParty: 'local_authority',
        laContractId: contractId,
        ...(learner.apPlacement
          ? {
              apPlacement: {
                apStartDate: learner.apPlacement.apStartDate.toISOString(),
                apReviewDate: learner.apPlacement.apReviewDate.toISOString(),
                apEndDate: learner.apPlacement.apEndDate?.toISOString() ?? null,
                statutoryReason: learner.apPlacement.statutoryReason,
                reviewStatus: 'pending',
              },
            }
          : {}),
        createdById: ctx.actorId,
        updatedById: ctx.actorId,
      },
    })
    await db.familyMember.create({
      data: {
        id: createId(),
        familyId,
        contactId,
        role: 'student',
        createdById: ctx.actorId,
        updatedById: ctx.actorId,
      },
    })
    if (learner.apPlacement) {
      await db.aPPlacement.create({
        data: {
          id: createId(),
          familyId,
          apStartDate: learner.apPlacement.apStartDate,
          apReviewDate: learner.apPlacement.apReviewDate,
          apEndDate: learner.apPlacement.apEndDate ?? null,
          statutoryReason: learner.apPlacement.statutoryReason,
          reviewStatus: 'pending',
          createdById: ctx.actorId,
          updatedById: ctx.actorId,
        },
      })
    }
    familyIds.push(familyId)
  }

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'lacontract_created',
      tenderId: input.tenderId,
      laContractId: contractId,
      occurredAt: new Date(),
      summary: `LAContract created for ${input.laName}`,
      payload: {
        event: 'lacontract.created',
        contractId,
        reference: input.reference,
        learnerCount: input.learnerPlacements.length,
        familyIds,
        retentionPolicyId,
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'lacontract.created',
    target: { type: 'LAContract', id: contractId },
    requestId: ctx.requestId,
    after: {
      tenderId: input.tenderId,
      laName: input.laName,
      reference: input.reference,
      contractValueMinor: input.contractValueMinor,
      familyIds,
      retentionPolicyId,
    },
  })

  return { contractId, familyIds, retentionPolicyId }
}

export * from './invariants'
export {
  generateProgressReportDraft,
  signoffProgressReport,
  type GenerateProgressReportInput,
  type GenerateProgressReportResult,
  type ReportRunner,
  type SignoffProgressReportInput,
} from './reports'
export {
  exportReportPdf,
  renderReportPdf,
  type ExportReportPdfInput,
  type PdfUploader,
} from './pdf'
export {
  generateLAInvoice,
  markLAInvoicePaid,
  markLAInvoiceSent,
  type GenerateLAInvoiceInput,
  type GenerateLAInvoiceResult,
  type LAInvoiceState,
  type MarkLAInvoicePaidInput,
  type MarkLAInvoiceSentInput,
} from './invoicing'
