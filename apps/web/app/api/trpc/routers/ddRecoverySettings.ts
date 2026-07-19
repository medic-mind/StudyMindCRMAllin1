// Customisable Direct Debit recovery settings (ADR 0045 amendment). The policy
// figures behind the chase flow — late fee, default cadence, response window,
// finance phone and the letterhead on the generated PDF — editable from
// Settings so the whole flow is customisable, not just the copy. The calculated
// CCJ court fee + statutory interest are fixed by law and stay in code.
// Manager+ (matches the recovery-templates admin). CLAUDE.md §20, §27.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { loadDdRecoverySettings } from '@/lib/finance/recovery-settings'
import { protectedProcedure, requireUser, router, type UserRole } from '@/lib/trpc/builders'

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set(['ceo', 'senior_manager', 'manager'])

function assertManage(role: UserRole): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Manager and above only' })
  }
}

const UpdateInput = z.object({
  lateFeePounds: z.number().min(0).max(1_000),
  defaultCadenceDays: z.number().int().min(1).max(60),
  responseDays: z.number().int().min(1).max(120),
  financePhone: z.string().trim().min(3).max(40),
  companyName: z.string().trim().min(1).max(120),
  companyAddress: z.string().trim().min(1).max(300),
})

export const ddRecoverySettingsRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    assertManage(requireUser(ctx).role)
    return loadDdRecoverySettings(ctx.db)
  }),

  update: protectedProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertManage(user.role)
    const lateFeeMinor = Math.round(input.lateFeePounds * 100)
    const fields = {
      lateFeeMinor,
      defaultCadenceDays: input.defaultCadenceDays,
      responseDays: input.responseDays,
      financePhone: input.financePhone.trim(),
      companyName: input.companyName.trim(),
      companyAddress: input.companyAddress.trim(),
    }
    await ctx.db.ddRecoverySettings.upsert({
      where: { id: 'dd_recovery' },
      create: { id: 'dd_recovery', ...fields, createdById: user.id, updatedById: user.id },
      update: { ...fields, updatedById: user.id },
    })
    await ctx.audit({
      action: 'dd_recovery_settings.updated',
      target: { type: 'DdRecoverySettings', id: 'dd_recovery' },
      after: fields,
    })
    return { ok: true }
  }),
})
