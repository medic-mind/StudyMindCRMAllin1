// Automated Direct Debit chase decisions (ADR 0045). Pure — the hourly engine
// (worker boundary) queries state and sends; this decides. Escalation walks
// the staff-authored DdRecoveryTemplate sequence in order, so each message is
// more serious than the last; when the sequence runs out the case flags for a
// human instead of nagging forever. Nothing is ever sent without the
// staff-pasted re-signup link, and a case someone marked up to date (or that
// auto-resolved from the GoCardless mirror) never sends again.

export type ChaseChannel = 'email' | 'sms'

export interface ChaseTemplateRef {
  id: string
  channel: ChaseChannel
  subject: string | null
  body: string
}

export type RecoveryStrategy = 'resend_link' | 'demand_full'

export interface ChaseCaseState {
  status: 'new' | 'chasing' | 'escalated' | 'recovered' | 'written_off'
  autoChase: boolean
  sendEmails: boolean
  sendTexts: boolean
  chaseEmail: string | null
  chasePhoneE164: string | null
  setupLinkUrl: string | null
  /** The recovery goal (ADR 0045 amendment). `resend_link` chases them back
   *  onto a plan and needs the re-signup link before it sends; `demand_full`
   *  demands the whole outstanding balance and needs no link. Defaults to
   *  `resend_link` when a caller doesn't set it. */
  recoveryStrategy?: RecoveryStrategy
  escalationStep: number
  nextAutoMessageAt: Date | null
}

export type ChaseTickDecision =
  | { kind: 'skip'; reason: 'closed' | 'auto_off' | 'no_link' | 'not_due' | 'no_channel' }
  /** Every enabled channel's sequence has been fully sent — stop and flag
   *  for a human call instead of repeating the final notice forever. */
  | { kind: 'exhausted' }
  | { kind: 'send'; sends: Array<{ channel: ChaseChannel; to: string; template: ChaseTemplateRef }> }

const CLOSED = new Set(['recovered', 'written_off'])

/**
 * What (if anything) the engine should send for one case right now.
 * Templates arrive ordered most-polite → most-serious; the escalation step
 * indexes into each channel's sequence (clamped to its last entry so a
 * shorter SMS sequence keeps pace with a longer email one).
 */
export function decideChaseTick(input: {
  cs: ChaseCaseState
  now: Date
  emailTemplates: ChaseTemplateRef[]
  smsTemplates: ChaseTemplateRef[]
}): ChaseTickDecision {
  const { cs, now } = input
  if (CLOSED.has(cs.status)) return { kind: 'skip', reason: 'closed' }
  if (!cs.autoChase) return { kind: 'skip', reason: 'auto_off' }
  // The re-signup goal cannot send until the link is pasted; demanding the full
  // balance needs no link (the templates carry the pay-in-full instructions).
  if ((cs.recoveryStrategy ?? 'resend_link') === 'resend_link' && !cs.setupLinkUrl) {
    return { kind: 'skip', reason: 'no_link' }
  }
  if (!cs.nextAutoMessageAt || cs.nextAutoMessageAt.getTime() > now.getTime()) {
    return { kind: 'skip', reason: 'not_due' }
  }

  const channels: Array<{ channel: ChaseChannel; to: string; templates: ChaseTemplateRef[] }> = []
  if (cs.sendEmails && cs.chaseEmail && input.emailTemplates.length > 0) {
    channels.push({ channel: 'email', to: cs.chaseEmail, templates: input.emailTemplates })
  }
  if (cs.sendTexts && cs.chasePhoneE164 && input.smsTemplates.length > 0) {
    channels.push({ channel: 'sms', to: cs.chasePhoneE164, templates: input.smsTemplates })
  }
  if (channels.length === 0) return { kind: 'skip', reason: 'no_channel' }

  const longestSequence = Math.max(...channels.map((c) => c.templates.length))
  if (cs.escalationStep >= longestSequence) return { kind: 'exhausted' }

  return {
    kind: 'send',
    sends: channels.map((c) => ({
      channel: c.channel,
      to: c.to,
      template: c.templates[Math.min(cs.escalationStep, c.templates.length - 1)]!,
    })),
  }
}

// -----------------------------------------------------------------------------
// Automatic arming (ADR 0045 amendment). Operators asked that automated
// reminders "just work" without arming every case by hand. When the operator
// turns on automatic chasing (Settings → Direct Debit recovery), the hourly
// engine arms every NEW, un-touched case: it turns on the enabled channels the
// case can actually reach, attaches the single global re-signup link, and
// schedules the first message. SAFE by construction: only fires when the
// operator enabled it AND a global re-signup link is set (the resend_link goal
// cannot send without one, §3), and never overrides a case a human already
// configured or paused.
// -----------------------------------------------------------------------------

export interface AutoChaseConfig {
  /** Master switch — nothing is auto-armed unless the operator turned this on. */
  autoChaseEnabled: boolean
  /** The one global re-signup link armed cases send. Null ⇒ cannot arm. */
  autoChaseSetupLinkUrl: string | null
  autoChaseEmail: boolean
  autoChaseSms: boolean
}

/** The fields to write when auto-arming a case. */
export interface AutoArmPatch {
  setupLinkUrl: string
  recoveryStrategy: RecoveryStrategy
  sendEmails: boolean
  sendTexts: boolean
  nextAutoMessageAt: Date
}

/** A case is "already armed / touched" when a human (or a prior arm) has given
 *  it a link or switched a channel on — we never override that. */
function isCaseArmed(cs: Pick<ChaseCaseState, 'setupLinkUrl' | 'sendEmails' | 'sendTexts'>): boolean {
  return Boolean(cs.setupLinkUrl) || cs.sendEmails || cs.sendTexts
}

/**
 * Decide whether to auto-arm one open case right now, and with what. Returns the
 * patch to apply, or null to leave the case as-is. Pure — the engine persists.
 *
 * Arms only when: the operator enabled auto-chase, a global re-signup link is
 * set, the case is open + not already armed/paused, and the case can reach the
 * customer on at least one enabled channel (has an email / an E.164 phone).
 */
export function decideAutoArm(
  cs: ChaseCaseState,
  config: AutoChaseConfig,
  now: Date,
): AutoArmPatch | null {
  if (!config.autoChaseEnabled) return null
  if (CLOSED.has(cs.status)) return null
  if (!cs.autoChase) return null // a human paused it — respect that.
  if (isCaseArmed(cs)) return null // already configured — never override.
  // The resend_link goal (get them back onto a plan) needs the link to send.
  const link = config.autoChaseSetupLinkUrl?.trim()
  if (!link) return null

  const sendEmails = config.autoChaseEmail && Boolean(cs.chaseEmail)
  const sendTexts =
    config.autoChaseSms && Boolean(cs.chasePhoneE164 && cs.chasePhoneE164.trim().startsWith('+'))
  if (!sendEmails && !sendTexts) return null // no channel we can actually reach.

  return {
    setupLinkUrl: link,
    recoveryStrategy: 'resend_link',
    sendEmails,
    sendTexts,
    nextAutoMessageAt: now,
  }
}

/** When the next message is due after a successful send. */
export function nextChaseAt(now: Date, cadenceDays: number): Date {
  const days = Number.isFinite(cadenceDays) && cadenceDays >= 1 ? Math.floor(cadenceDays) : 3
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
}

/**
 * Has this person set their Direct Debit back up? True when the customer has
 * an ACTIVE mandate created AFTER the case was opened — the old mandate
 * surviving a cancelled plan does not count; a fresh sign-up does. (Stripe
 * re-signups can't be detected from the GC mirror — staff tick those off
 * manually.)
 */
export function chaseAutoResolved(
  caseOpenedAt: Date,
  mandates: Array<{ status: string; createdAt: Date }>,
): boolean {
  return mandates.some(
    (m) => m.status === 'active' && m.createdAt.getTime() > caseOpenedAt.getTime(),
  )
}
