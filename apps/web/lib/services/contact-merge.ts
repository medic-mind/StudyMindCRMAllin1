// Contact merge execution. CLAUDE.md §3 (humans confirm), §35 (no auto-merge),
// §41.1 (restricted_access invariants).
//
// Re-parents EVERY Contact relation (interactions, cards, conversations,
// GoCardless customers, booking profile/lessons/ledgers, tags/labels/subjects,
// B2B links, webinar enrolments, complaints, camp bookings, links, …) to the
// survivor, soft-deletes the loser, writes a contact.merged Interaction; the
// caller writes the audit entry. Composite-unique junctions and 1:1 satellites
// are de-duped so a confident same-person merge never throws or orphans data.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'

import { BusinessError } from '@studymind/core'

export interface MergeResult {
  survivorId: string
  loserId: string
  movedInteractions: number
  loserDeletedAt: Date
}

export async function mergeContacts(
  db: PrismaClient,
  args: { survivorId: string; loserId: string; actorUserId: string | null },
): Promise<MergeResult> {
  const { survivorId, loserId, actorUserId } = args
  if (survivorId === loserId) {
    throw new BusinessError('CONTACT_MERGE_SELF', 'Cannot merge a Contact with itself.')
  }

  return db.$transaction(async (tx) => {
    const survivor = await tx.contact.findUnique({
      where: { id: survivorId, deletedAt: null },
      include: {
        safeguardingFlags: { where: { deletedAt: null, state: 'restricted_access' } },
      },
    })
    const loser = await tx.contact.findUnique({
      where: { id: loserId, deletedAt: null },
      include: {
        safeguardingFlags: { where: { deletedAt: null, state: 'restricted_access' } },
      },
    })
    if (!survivor || !loser) {
      throw new BusinessError('CONTACT_NOT_FOUND', 'One or both Contacts no longer exist.')
    }

    // §41.1: cannot merge across different restricted-access DSL assignments.
    const sFlag = survivor.safeguardingFlags[0]
    const lFlag = loser.safeguardingFlags[0]
    if (sFlag && lFlag && sFlag.dslUserId !== lFlag.dslUserId) {
      throw new BusinessError(
        'CONTACT_MERGE_RESTRICTED_DSL_CONFLICT',
        'Both Contacts are restricted_access but assigned to different DSLs.',
      )
    }
    if ((sFlag && !lFlag) || (!sFlag && lFlag)) {
      throw new BusinessError(
        'CONTACT_MERGE_RESTRICTED_DSL_CONFLICT',
        'Cannot merge: only one side is restricted_access.',
      )
    }

    // Re-parent Interactions.
    const moved = await tx.interaction.updateMany({
      where: { contactId: loserId },
      data: { contactId: survivorId },
    })

    // Re-parent FamilyMember rows where survivor is not already a member of
    // the same family (avoid violating the @@unique([familyId, contactId])).
    const loserMemberships = await tx.familyMember.findMany({
      where: { contactId: loserId },
      select: { id: true, familyId: true },
    })
    for (const m of loserMemberships) {
      const conflict = await tx.familyMember.findUnique({
        where: { familyId_contactId: { familyId: m.familyId, contactId: survivorId } },
      })
      if (conflict) {
        await tx.familyMember.delete({ where: { id: m.id } })
      } else {
        await tx.familyMember.update({
          where: { id: m.id },
          data: { contactId: survivorId },
        })
      }
    }

    // Re-parent any Family that pointed at loser as billing contact.
    await tx.family.updateMany({
      where: { billingContactId: loserId },
      data: { billingContactId: survivorId },
    })

    // FinancialAccount and Bookings hang off Family, so the family re-parenting
    // above already moves them with their Family.

    // Re-parent EVERY other Contact relation to the survivor. The loser is only
    // SOFT-deleted, so any row left pointing at it is orphaned — invisible on
    // the survivor and, for a card, a ghost still shown on the board with the
    // deleted contact's name. Simple 1:N relations move wholesale; the
    // composite-unique junctions drop the rows that would collide on the
    // survivor first (so both records having the same tag/label/account/class
    // doesn't throw); the 1:1 satellites keep the survivor's; ContactLink is
    // de-duped and self-link-guarded.
    for (const move of [
      () => tx.card.updateMany({ where: { contactId: loserId }, data: { contactId: survivorId } }),
      () =>
        tx.conversation.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.contactFieldSuggestion.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.safeguardingFlag.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.contactDocument.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.bookingLesson.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.bookingHoursTransaction.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.bookingCreditTransaction.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.gcCustomer.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.uploadedInvoice.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.mandateSetupLink.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.invoicingCustomer.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.complaint.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.campStripePurchase.updateMany({
          where: { contactId: loserId },
          data: { contactId: survivorId },
        }),
      () =>
        tx.campBookingRecord.updateMany({
          where: { studentContactId: loserId },
          data: { studentContactId: survivorId },
        }),
      () =>
        tx.campBookingRecord.updateMany({
          where: { guardianContactId: loserId },
          data: { guardianContactId: survivorId },
        }),
    ]) {
      await move()
    }

    // Composite-unique junctions: delete loser rows that would collide with an
    // existing survivor row on the OTHER key, then move the remainder.
    const survCompanies = (
      await tx.contactCompany.findMany({ where: { contactId: survivorId }, select: { companyId: true } })
    ).map((r) => r.companyId)
    if (survCompanies.length) {
      await tx.contactCompany.deleteMany({
        where: { contactId: loserId, companyId: { in: survCompanies } },
      })
    }
    await tx.contactCompany.updateMany({
      where: { contactId: loserId },
      data: { contactId: survivorId },
    })

    const survSubjects = (
      await tx.contactSubject.findMany({ where: { contactId: survivorId }, select: { subjectId: true } })
    ).map((r) => r.subjectId)
    if (survSubjects.length) {
      await tx.contactSubject.deleteMany({
        where: { contactId: loserId, subjectId: { in: survSubjects } },
      })
    }
    await tx.contactSubject.updateMany({
      where: { contactId: loserId },
      data: { contactId: survivorId },
    })

    const survLabels = (
      await tx.contactLabel.findMany({ where: { contactId: survivorId }, select: { labelId: true } })
    ).map((r) => r.labelId)
    if (survLabels.length) {
      await tx.contactLabel.deleteMany({
        where: { contactId: loserId, labelId: { in: survLabels } },
      })
    }
    await tx.contactLabel.updateMany({
      where: { contactId: loserId },
      data: { contactId: survivorId },
    })

    const survAccounts = (
      await tx.businessAccountContact.findMany({
        where: { contactId: survivorId },
        select: { accountId: true },
      })
    ).map((r) => r.accountId)
    if (survAccounts.length) {
      await tx.businessAccountContact.deleteMany({
        where: { contactId: loserId, accountId: { in: survAccounts } },
      })
    }
    await tx.businessAccountContact.updateMany({
      where: { contactId: loserId },
      data: { contactId: survivorId },
    })

    const survClasses = (
      await tx.webinarEnrollment.findMany({
        where: { contactId: survivorId },
        select: { classId: true },
      })
    ).map((r) => r.classId)
    if (survClasses.length) {
      await tx.webinarEnrollment.deleteMany({
        where: { contactId: loserId, classId: { in: survClasses } },
      })
    }
    await tx.webinarEnrollment.updateMany({
      where: { contactId: loserId },
      data: { contactId: survivorId },
    })

    // 1:1 satellites (contactId is the PK): keep the survivor's; move the
    // loser's only when the survivor has none.
    if (await tx.contactBookingProfile.findFirst({ where: { contactId: survivorId }, select: { contactId: true } })) {
      await tx.contactBookingProfile.deleteMany({ where: { contactId: loserId } })
    } else {
      await tx.contactBookingProfile.updateMany({
        where: { contactId: loserId },
        data: { contactId: survivorId },
      })
    }
    if (await tx.contactRiskReview.findFirst({ where: { contactId: survivorId }, select: { contactId: true } })) {
      await tx.contactRiskReview.deleteMany({ where: { contactId: loserId } })
    } else {
      await tx.contactRiskReview.updateMany({
        where: { contactId: loserId },
        data: { contactId: survivorId },
      })
    }

    // ContactLink (from/to): repoint at the survivor, dropping any link that
    // would become a self-link or duplicate an existing survivor link.
    const linksFrom = await tx.contactLink.findMany({ where: { fromContactId: loserId } })
    for (const l of linksFrom) {
      if (l.toContactId === survivorId) {
        await tx.contactLink.delete({ where: { id: l.id } })
        continue
      }
      const dup = await tx.contactLink.findUnique({
        where: {
          fromContactId_toContactId_relation: {
            fromContactId: survivorId,
            toContactId: l.toContactId,
            relation: l.relation,
          },
        },
        select: { id: true },
      })
      if (dup) await tx.contactLink.delete({ where: { id: l.id } })
      else await tx.contactLink.update({ where: { id: l.id }, data: { fromContactId: survivorId } })
    }
    const linksTo = await tx.contactLink.findMany({ where: { toContactId: loserId } })
    for (const l of linksTo) {
      if (l.fromContactId === survivorId) {
        await tx.contactLink.delete({ where: { id: l.id } })
        continue
      }
      const dup = await tx.contactLink.findUnique({
        where: {
          fromContactId_toContactId_relation: {
            fromContactId: l.fromContactId,
            toContactId: survivorId,
            relation: l.relation,
          },
        },
        select: { id: true },
      })
      if (dup) await tx.contactLink.delete({ where: { id: l.id } })
      else await tx.contactLink.update({ where: { id: l.id }, data: { toContactId: survivorId } })
    }

    // Soft-delete the loser.
    const now = new Date()
    await tx.contact.update({
      where: { id: loserId },
      data: { deletedAt: now, updatedById: actorUserId },
    })

    // contact.merged timeline event on the survivor.
    await tx.interaction.create({
      data: {
        id: createId(),
        type: 'system',
        contactId: survivorId,
        occurredAt: now,
        summary: `Merged from ${loserId}`,
        payload: {
          event: 'contact.merged',
          survivorId,
          loserId,
          actorUserId,
        },
      },
    })

    return {
      survivorId,
      loserId,
      movedInteractions: moved.count,
      loserDeletedAt: now,
    }
  })
}
