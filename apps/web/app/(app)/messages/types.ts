// Client-safe view types for the messaging workspace (ADR 0022). Derived from
// the tRPC router output so the UI and the server can never drift. Type-only —
// nothing here pulls server code into the client bundle.

import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@/app/api/trpc/root'

type RouterOutputs = inferRouterOutputs<AppRouter>
type RouterInputs = inferRouterInputs<AppRouter>

/** The curated reaction-emoji union, derived from the router input schema. */
export type ReactionEmoji = RouterInputs['chat']['react']['emoji']

export type ChannelView = RouterOutputs['chat']['listChannels']['channels'][number]
export type MessageView = RouterOutputs['chat']['listMessages']['items'][number]
export type MessageRef = MessageView['refs'][number]
export type MessageReaction = MessageView['reactions'][number]
export type MessageAttachment = MessageView['attachments'][number]
export type ChannelMember = RouterOutputs['chat']['members'][number]
export type MentionItem = RouterOutputs['chat']['mentions']['items'][number]
export type RefSearchHit = RouterOutputs['chat']['refSearch']['results'][number]
export type UserHit = RouterOutputs['chat']['userSearch'][number]
export type SearchHit = RouterOutputs['chat']['search']['hits'][number]
