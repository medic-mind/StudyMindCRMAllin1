// Team domain. Internal ops squads — tasks can be assigned to a team in
// addition to (or instead of) a person. Membership is CEO/Senior Manager
// territory. CLAUDE.md §20.

import { z } from 'zod'

export const TeamCreateInput = z.object({
  name: z.string().trim().min(1).max(80),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/u, 'Use a #RRGGBB hex colour')
    .optional(),
  description: z.string().trim().max(280).optional(),
})
export type TeamCreateInput = z.infer<typeof TeamCreateInput>

export const TeamUpdateInput = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(80).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/u, 'Use a #RRGGBB hex colour')
    .nullish(),
  description: z.string().trim().max(280).nullish(),
})
export type TeamUpdateInput = z.infer<typeof TeamUpdateInput>

export const TeamSummary = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  memberCount: z.number().int(),
  archived: z.boolean(),
})
export type TeamSummary = z.infer<typeof TeamSummary>
