// Deterministic noise gate — runs BEFORE any AI spend (CLAUDE.md §32). Most
// Slack traffic ("ok", "thanks 👍", a bare link, a lone emoji) cannot
// reference a customer, so paying the slack_summary model for it is waste
// and it would only ever land in the triage tray as clutter. The gate is
// deliberately conservative: anything carrying an email, a phone-shaped
// digit run, or at least two real words goes through to the AI.

export function isSkippableSlackNoise(text: string): boolean {
  const stripped = text
    // Slack-wrapped links <https://…|label> and bare URLs.
    .replace(/<https?:[^>]+>/gu, ' ')
    .replace(/https?:\/\/\S+/gu, ' ')
    // User / channel / special mentions: <@U…>, <#C…>, <!here>.
    .replace(/<[@#!][^>]+>/gu, ' ')
    // :emoji: codes.
    .replace(/:[a-z0-9_+-]+:/giu, ' ')
    .trim()

  // An email or a phone-shaped digit run is always worth parsing.
  if (/[\w.+-]+@[\w-]+\.[a-z]/iu.test(stripped)) return false
  if (/\d[\d\s().-]{5,}/u.test(stripped)) return false

  // Fewer than two real words (≥2 letters) → reactions, acks, lone names of
  // emoji — never enough signal to identify a customer matter.
  const words = stripped.split(/\s+/u).filter((w) => /\p{L}{2,}/u.test(w))
  if (words.length < 2) return true
  if (stripped.length < 8) return true
  return false
}
