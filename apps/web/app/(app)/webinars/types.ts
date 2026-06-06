// Inferred view types for the webinar client components, so initialData and
// props match the tRPC procedure outputs exactly (no hand-drift).

import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@/app/api/trpc/root'

type RouterOutputs = inferRouterOutputs<AppRouter>

export type CohortRow = RouterOutputs['webinar']['cohort']['list'][number]
export type CohortDetail = RouterOutputs['webinar']['cohort']['get']
export type ClassRow = RouterOutputs['webinar']['class']['list'][number]
export type ClassDetailView = RouterOutputs['webinar']['class']['get']
export type EnrollmentRow = RouterOutputs['webinar']['enrollment']['list'][number]
export type WebinarSettingsView = RouterOutputs['webinar']['settings']['get']
export type CataloguePick = RouterOutputs['webinar']['subject']['pickList'][number]
export type CatalogueRow = RouterOutputs['webinar']['subject']['list'][number]
