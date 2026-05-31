// Chat domain types + Zod IO schemas (ADR 0022). The same input schemas are
// imported by the tRPC procedures and the React Hook Form / composer state so
// client and server validate one shape (CLAUDE.md §27).

import { z } from 'zod'

import { CHAT_REF_TYPES } from './parse'

/** Channel kinds an operator can create from the UI (DMs are made implicitly). */
export const CHAT_CHANNEL_KINDS = ['public', 'private'] as const
export type ChatChannelKind = (typeof CHAT_CHANNEL_KINDS)[number]

/** Per-channel notification preference. */
export const CHAT_NOTIFY_LEVELS = ['all', 'mentions', 'none'] as const
export type ChatNotifyLevel = (typeof CHAT_NOTIFY_LEVELS)[number]

/**
 * Curated reaction set. CLAUDE.md §4 forbids emoji in product *chrome*; these
 * are user-authored content, deliberately limited to a small, tasteful palette
 * rather than the full unicode set so storage and rendering stay predictable.
 */
export const CHAT_REACTION_EMOJI = [
  '👍',
  '🎉',
  '❤️',
  '😂',
  '👀',
  '✅',
  '🙏',
  '🔥',
  '😮',
  '🚀',
] as const
export type ChatReactionEmoji = (typeof CHAT_REACTION_EMOJI)[number]

// Channel name: lower-kebab slug, 1–60 chars. We normalise spaces → hyphens in
// the domain layer before validating, so a user can type "Sales Wins".
export const ChannelNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the channel a name')
  .max(60, 'Channel names are 60 characters or fewer')

export const CreateChannelInput = z.object({
  name: ChannelNameSchema,
  kind: z.enum(CHAT_CHANNEL_KINDS).default('public'),
  topic: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  /** Initial members (besides the creator). Required-ish for private channels. */
  memberIds: z.array(z.string().min(1)).max(200).optional(),
})
export type CreateChannelInput = z.infer<typeof CreateChannelInput>

export const UpdateChannelInput = z.object({
  id: z.string().min(1),
  name: ChannelNameSchema.optional(),
  topic: z.string().trim().max(200).nullish(),
  description: z.string().trim().max(2000).nullish(),
})
export type UpdateChannelInput = z.infer<typeof UpdateChannelInput>

/** Metadata for an attachment already staged to S3 (two-phase upload). */
export const StagedAttachmentInput = z.object({
  id: z.string().min(1),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  s3Key: z.string().min(1),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
})
export type StagedAttachmentInput = z.infer<typeof StagedAttachmentInput>

export const SendMessageInput = z
  .object({
    channelId: z.string().min(1),
    // Body may be empty when at least one attachment is present (image with no
    // caption). The domain enforces the "text OR attachment" rule.
    body: z.string().trim().max(8000, 'Message is too long').default(''),
    /** Set to post into a thread (the id of the thread's root message). */
    parentId: z.string().min(1).nullish(),
    attachments: z.array(StagedAttachmentInput).max(10).optional(),
  })
  .refine((v) => v.body.length > 0 || (v.attachments?.length ?? 0) > 0, {
    message: 'Type a message or attach a file',
    path: ['body'],
  })
export type SendMessageInput = z.infer<typeof SendMessageInput>

export const EditMessageInput = z.object({
  id: z.string().min(1),
  body: z.string().trim().min(1).max(8000),
})
export type EditMessageInput = z.infer<typeof EditMessageInput>

export const ReactInput = z.object({
  messageId: z.string().min(1),
  emoji: z.enum(CHAT_REACTION_EMOJI),
})
export type ReactInput = z.infer<typeof ReactInput>

export const RefTypeSchema = z.enum(CHAT_REF_TYPES)

// --- View-model types shared between the router output and the UI -------------

export interface ChatUserLite {
  id: string
  name: string
  email: string
}

export interface ChatRefView {
  type: (typeof CHAT_REF_TYPES)[number]
  id: string
  label: string
  /** In-app href for the chip, or null when the entity was not found. */
  href: string | null
}

export interface ChatReactionView {
  emoji: string
  count: number
  /** Whether the current viewer reacted with this emoji. */
  mine: boolean
  /** Display names of reactors, for the tooltip. */
  names: string[]
}

export interface ChatAttachmentView {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  width: number | null
  height: number | null
  /** Images render inline; everything else as a download chip. */
  isImage: boolean
  /** Proxy download URL (never a raw S3 link — keeps the audit honest). */
  url: string
}

export interface ChatMessageView {
  id: string
  channelId: string
  authorId: string
  authorName: string
  body: string
  parentId: string | null
  replyCount: number
  lastReplyAt: Date | null
  editedAt: Date | null
  deletedAt: Date | null
  createdAt: Date
  mentionUserIds: string[]
  refs: ChatRefView[]
  reactions: ChatReactionView[]
  /** Names of the latest few thread repliers, for the "N replies" affordance. */
  replyAuthorNames: string[]
  attachments: ChatAttachmentView[]
}

export interface ChatChannelView {
  id: string
  kind: 'public' | 'private' | 'dm'
  name: string | null
  /** Resolved display title (DMs render their members' names). */
  title: string
  topic: string | null
  description: string | null
  isGeneral: boolean
  archived: boolean
  member: boolean
  notifyLevel: ChatNotifyLevel
  muted: boolean
  unreadCount: number
  mentionCount: number
  lastMessageAt: Date | null
  /** For DMs: the other participants (excludes the viewer). */
  dmMembers: ChatUserLite[]
}
