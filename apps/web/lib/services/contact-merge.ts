// Contact merge execution. CLAUDE.md §3 (humans confirm), §35 (no auto-merge),
// §41.1 (restricted_access invariants).
//
// Re-parents Interactions, FamilyMember rows, FinancialAccount-via-Family,
// and Bookings (via Family) to the survivor; soft-deletes the loser; writes
// a contact.merged Interaction; the caller writes the audit entry.

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
  args: { survivorId: string; loserId: string; actorUserId: string },
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
    // above already moves them with their Family. Nothing else to do.

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
