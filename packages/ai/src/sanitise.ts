// PII and prompt-injection sanitiser. See CLAUDE.md Section 18.3 and 44.2.

export interface SanitiseOptions {
  redactMinorNames?: boolean
  redactEmails?: boolean
  stripControlTokens?: boolean
}

export function sanitiseForPrompt(_input: string, _opts: SanitiseOptions = {}): string {
  throw new Error('not implemented')
}
