// Reply draft prompt. CLAUDE.md §4 (voice), §18.1 (style fragments imported,
// not inlined). Free-text output validated post-hoc with content-shape Zod.
//
// Channel-aware: WhatsApp/SMS get short, low-formality drafts; email gets
// salutation + sign-off; web chat sits in between. Drafts are LABELLED
// AI-drafted in the UI — the agent edits and confirms before send.

import { z } from 'zod'

import { sanitiseUserContent } from '../sanitise'
import { HOUSE_STYLE_REPLY } from './style/house'
import { SAFEGUARDING_GUARDRAIL } from './style/safeguarding'
import { VOICE } from './style/voice'

export const VERSION = '2026-05-09.1'

export type ReplyChannel = 'email' | 'whatsapp' | 'sms' | 'web_chat'

/** A trimmed thread item shown to the model. PII already sanitised. */
export interface InteractionListItem {
  type: string
  occurredAt: string
  direction: 'inbound' | 'outbound' | 'internal'
  /** Already redacted with sanitiseUserContent. */
  text: string
}

export interface ReplyDraftPromptInput {
  channel: ReplyChannel
  goal: string
  thread: InteractionListItem[]
}

const SYSTEM_BASE = `
${VOICE}

${HOUSE_STYLE_REPLY}

${SAFEGUARDING_GUARDRAIL}
`.trim()

function channelGuidance(channel: ReplyChannel): string {
  switch (channel) {
    case 'email':
      return [
        'Channel: email.',
        'Open with a short greeting using the parent or caseworker first name when known.',
        'One or two short paragraphs. Sign off with a friendly closer ("Kind regards,") and the sender placeholder "{{agentName}}".',
      ].join(' ')
    case 'whatsapp':
    case 'sms':
      return [
        `Channel: ${channel}.`,
        'Short — one short paragraph or 2–3 short sentences total. No salutation, no sign-off.',
        'Plain text only, no markdown.',
      ].join(' ')
    case 'web_chat':
      return [
        'Channel: web chat.',
        'Conversational, 1–3 short sentences. No formal salutation or sign-off.',
      ].join(' ')
  }
}

export function buildReplyDraftPrompt(
  input: ReplyDraftPromptInput,
): { system: string; user: string; promptVersion: string } {
  const goal = sanitiseUserContent(input.goal).slice(0, 500)
  const thread = input.thread.slice(0, 20).map((i) => ({
    type: i.type,
    direction: i.direction,
    at: i.occurredAt,
    text: sanitiseUserContent(i.text).slice(0, 1500),
  }))
  const guidance = channelGuidance(input.channel)
  const user = [
    `Goal of reply: ${goal}`,
    `Channel guidance: ${guidance}`,
    `Recent thread (most recent last):\n${JSON.stringify(thread, null, 2)}`,
    'Draft the reply only. Do not include explanations, headers, or quoted thread.',
  ].join('\n\n')
  return { system: SYSTEM_BASE, user, promptVersion: VERSION }
}

/**
 * Channel-specific content-shape schemas. Length bounds match the
 * conventions in channelGuidance and reject the literal "[REDACTED:" leak
 * marker from the sanitiser.
 */
export function replyDraftShape(channel: ReplyChannel): z.ZodType<string> {
  const noLeak = (s: string) => !/\[REDACTED:[a-z]+\]/i.test(s)
  switch (channel) {
    case 'sms':
      return z
        .string()
        .min(1)
        .max(480)
        .refine(noLeak, { message: 'draft contains a leaked redaction marker' })
    case 'whatsapp':
      return z
        .string()
        .min(1)
        .max(700)
        .refine(noLeak, { message: 'draft contains a leaked redaction marker' })
    case 'web_chat':
      return z
        .string()
        .min(1)
        .max(600)
        .refine(noLeak, { message: 'draft contains a leaked redaction marker' })
    case 'email':
      // Require some kind of closer — "Kind regards", "Thanks", "Best", or the
      // placeholder we instruct the model to use. The check is intentionally
      // loose; agents edit before send.
      return z
        .string()
        .min(20)
        .max(4000)
        .refine(noLeak, { message: 'draft contains a leaked redaction marker' })
        .refine((s) => /(kind regards|thanks|best|warm regards|{{agentName}})/i.test(s), {
          message: 'email draft missing a closer',
        })
  }
}
