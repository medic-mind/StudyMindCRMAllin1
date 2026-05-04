// PII and prompt-injection sanitiser. See CLAUDE.md Sections 18.3, 21, and 44.2.
//
// Two functions:
// - sanitiseUserContent: strips control tokens and prompt-injection-shaped
//   content from inbound user-supplied text BEFORE it reaches a prompt.
// - redactPII: replaces UK-shaped PII tokens (phone, email, NHS, card, IBAN)
//   with [REDACTED:<kind>] markers. Use for log output and for any prompt
//   input where the PII is not strictly necessary for the task.

const MAX_LENGTH = 8000
const TRUNCATION_MARKER = '\n[…truncated]'

// ChatML / role markers and other control tokens we strip wholesale. Any
// future provider-specific marker should be added here.
const CONTROL_TOKEN_PATTERNS: RegExp[] = [
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<\|endoftext\|>/gi,
  /<\|system\|>/gi,
  /<\|user\|>/gi,
  /<\|assistant\|>/gi,
  /<system>/gi,
  /<\/system>/gi,
  /<user>/gi,
  /<\/user>/gi,
  /<assistant>/gi,
  /<\/assistant>/gi,
]

// Prompt-injection-shaped phrases. Case-insensitive; we strip the whole
// phrase, not just the trigger word, so the surrounding instruction does not
// survive. The list is conservative; false positives are preferable to
// successful injections.
const INJECTION_PHRASE_PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|preceding) (instructions?|prompts?|messages?|context)[^.\n]*/gi,
  /disregard (all |any |the )?(previous|prior|above|preceding)[^.\n]*/gi,
  /forget (all |any |the )?(previous|prior|above|everything)[^.\n]*/gi,
  /you are (now |actually )?(a |an )?[^.\n]*/gi,
  /act as (a |an |if )?[^.\n]*/gi,
  /pretend (to be|you are)[^.\n]*/gi,
  /from now on[^.\n]*/gi,
  /system prompt[^.\n]*/gi,
  /reveal (your |the )?(system|hidden|secret)[^.\n]*/gi,
]

export function sanitiseUserContent(input: string): string {
  if (typeof input !== 'string') return ''
  let out = input

  for (const pattern of CONTROL_TOKEN_PATTERNS) {
    out = out.replace(pattern, ' ')
  }
  for (const pattern of INJECTION_PHRASE_PATTERNS) {
    out = out.replace(pattern, ' ')
  }

  // Collapse runs of horizontal whitespace, keep paragraph breaks intact.
  out = out.replace(/[ \t]+/g, ' ')
  out = out.replace(/\n{3,}/g, '\n\n')
  out = out.trim()

  if (out.length > MAX_LENGTH) {
    out = out.slice(0, MAX_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
  }

  return out
}

export interface RedactPIIOptions {
  keepFirstNameInitial?: boolean
}

// UK phone in E.164 (+44...) and national (07xxx, 02x, etc).
const PHONE_E164 = /\+\d{10,15}\b/g
const PHONE_UK_NATIONAL = /\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

// NHS number: 3-3-4 digits, optionally space- or dash-separated.
const NHS_NUMBER = /\b\d{3}[\s-]\d{3}[\s-]\d{4}\b/g

// Card-shaped 16 contiguous digits, optionally separated by spaces or dashes.
const CARD_NUMBER = /\b(?:\d{4}[\s-]?){3}\d{4}\b/g

// IBAN: 2 letters + 2 digits + 10–30 alphanumerics.
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g

export function redactPII(input: string, _opts: RedactPIIOptions = {}): string {
  if (typeof input !== 'string') return ''
  let out = input

  // Order matters: cards and IBANs first so their digit groups are not
  // consumed by the looser phone matchers.
  out = out.replace(IBAN, '[REDACTED:iban]')
  out = out.replace(CARD_NUMBER, '[REDACTED:card]')
  out = out.replace(NHS_NUMBER, '[REDACTED:nhs]')
  out = out.replace(EMAIL, '[REDACTED:email]')
  out = out.replace(PHONE_E164, '[REDACTED:phone]')
  out = out.replace(PHONE_UK_NATIONAL, '[REDACTED:phone]')

  return out
}
