// Branding tRPC router (CLAUDE.md §4, §20). The custom logo is a settings-tier
// change: CEO and Senior Manager only, audited. `status` is readable by any
// authenticated user so the shell can decide whether to render the custom
// logo. Bytes are served by the public GET /api/branding/logo route.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ALLOWED_LOGO_CONTENT_TYPES,
  clearBrandingLogo,
  getBrandingLogoMeta,
  InvalidLogoError,
  setBrandingLogo,
} from '@studymind/core/branding'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const BRANDING_MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
])

function assertCanManageBranding(role: UserRole): void {
  if (!BRANDING_MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only CEO and Senior Manager can change branding',
    })
  }
}

// ~1 MB base64 ceiling — a coarse guard before we decode; setBrandingLogo
// enforces the real 512 KB limit on the decoded bytes.
const SetLogoInput = z.object({
  dataBase64: z.string().min(1).max(1_000_000),
  contentType: z.enum(ALLOWED_LOGO_CONTENT_TYPES),
  fileName: z.string().trim().max(256).optional(),
})

export const brandingRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    return getBrandingLogoMeta(ctx.db)
  }),

  setLogo: auditedProcedure.input(SetLogoInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManageBranding(user.role)

    const data = Buffer.from(input.dataBase64, 'base64')
    try {
      const { version } = await setBrandingLogo(ctx.db, {
        data,
        contentType: input.contentType,
        fileName: input.fileName ?? null,
        actorId: user.id,
      })
      await ctx.audit({
        action: 'branding.logo_updated',
        target: { type: 'BrandingSetting', id: 'branding' },
        after: {
          contentType: input.contentType,
          fileName: input.fileName ?? null,
          bytes: data.byteLength,
        },
      })
      return { version }
    } catch (err) {
      if (err instanceof InvalidLogoError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
      }
      throw err
    }
  }),

  removeLogo: auditedProcedure.mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    assertCanManageBranding(user.role)

    const before = await getBrandingLogoMeta(ctx.db)
    const removed = await clearBrandingLogo(ctx.db)
    await ctx.audit({
      action: 'branding.logo_removed',
      target: { type: 'BrandingSetting', id: 'branding' },
      before: { hadLogo: before.hasLogo, contentType: before.contentType },
    })
    return { removed }
  }),
})
