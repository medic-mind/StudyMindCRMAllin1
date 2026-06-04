// Slack channel option domain types (CLAUDE.md §10/§12, §30). Pure Zod, no
// I/O — shared by the tRPC `slackChannel.*` procedures, the React Hook Form
// admin, and the call-summary Slack sender. A SlackChannelOption is an
// operator-managed Slack channel that a call summary can be posted to as an
// internal action point for virtual assistants, with optional deep-link
// action buttons rendered on the message.

import { z } from 'zod'

const Label = z.string().trim().min(1).max(80)
/** Slack channel id, e.g. C0123456789. Slack ids are uppercase alphanumeric. */
export const SlackChannelId = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Z0-9]+$/, 'Enter a Slack channel id like C0123456789')

/**
 * A single deep-link action button rendered on the posted Slack message. The
 * `url` may contain the `{{contactUrl}}` placeholder, substituted at send time
 * with the contact's CRM URL. Anything VAs should be able to click straight
 * from Slack. We only support URL buttons (no inbound Slack interactivity
 * endpoint yet — see ADR/roadmap), so every button must carry a url.
 */
export const SlackActionButton = z.object({
  label: z.string().trim().min(1).max(60),
  url: z.string().trim().min(1).max(2000),
})
export type SlackActionButton = z.infer<typeof SlackActionButton>

export const SlackActionButtons = z.array(SlackActionButton).max(5)
export type SlackActionButtons = z.infer<typeof SlackActionButtons>

export const SlackChannelOptionCreateInput = z.object({
  label: Label,
  channelId: SlackChannelId,
  purpose: z.string().trim().max(280).optional(),
  isDefault: z.boolean().default(false),
  actionButtons: SlackActionButtons.default([]),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})
export type SlackChannelOptionCreateInput = z.infer<typeof SlackChannelOptionCreateInput>

export const SlackChannelOptionUpdateInput = z.object({
  id: z.string(),
  label: Label.optional(),
  channelId: SlackChannelId.optional(),
  purpose: z.string().trim().max(280).nullish(),
  isDefault: z.boolean().optional(),
  actionButtons: SlackActionButtons.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})
export type SlackChannelOptionUpdateInput = z.infer<typeof SlackChannelOptionUpdateInput>

/** Parse a persisted `actionButtons` JSON column, tolerating legacy/empty. */
export function parseActionButtons(raw: unknown): SlackActionButton[] {
  const result = SlackActionButtons.safeParse(raw)
  return result.success ? result.data : []
}
