// Example contact router. See CLAUDE.md Section 27.

import { z } from 'zod'
import { protectedProcedure, router } from '@/lib/trpc/builders'

const ContactViewModel = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
})

export const contactRouter = router({
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .output(ContactViewModel)
    .query(async ({ input }) => {
      // Skeleton — real impl reads via @studymind/core, not directly from db.
      return {
        id: input.id,
        firstName: null,
        lastName: null,
        email: null,
      }
    }),

  list: protectedProcedure
    .input(
      z.object({
        cursor: z.string().nullish(),
        limit: z.number().min(1).max(100).default(25),
      }),
    )
    .output(
      z.object({
        items: z.array(ContactViewModel),
        nextCursor: z.string().nullable(),
      }),
    )
    .query(async () => {
      return { items: [], nextCursor: null }
    }),
})
