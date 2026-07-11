// Deterministic noise gate — runs BEFORE any AI spend (CLAUDE.md §32). Most
// Slack traffic ("ok", "thanks 👍", a bare link, a lone emoji) cannot
// reference a customer, so paying the slack_summary model for it is waste
// and it would only ever land in the triage tray as clutter. The gate is
// deliberately conservative: anything carrying an email, a phone-shaped
// digit run, at least two real words, OR a lone proper-noun-shaped token (a
// customer's name posted as a terse thread header — "Sampada") goes through.
// The lone-name exception exists because this gate used to HARD-DROP such
// messages in every ingest path — no record, no tray, no error — the one true
// silent drop on the default deployment; the deterministic name matcher (or
// the tray) now catches what passes through.

/** Proper-noun shape: capitalised segments joined by apostrophe/hyphen
 *  (Aanya, O'Brien, Anne-Marie; ALL-CAPS acronyms excluded; ≥2 chars).
 *  Mirrors extract.ts. */
const PROPER_NAME_TOKEN = /^(?=.{2,})\p{Lu}\p{Ll}*(?:['’-]\p{Lu}?\p{Ll}+)*$/u

/** Capitalised words that are acks/greetings/calendar words, not names. */
const CAPITALISED_NOISE = new Set([
  'thanks', 'thank', 'thankyou', 'cheers', 'ok', 'okay', 'yes', 'no', 'yep', 'nope',
  'done', 'great', 'nice', 'cool', 'perfect', 'brilliant', 'awesome', 'sure',
  'hello', 'hi', 'hey', 'morning', 'afternoon', 'evening', 'welcome', 'sorry',
  'please', 'noted', 'agreed', 'understood', 'lol', 'haha', 'update', 'reminder',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'today', 'tomorrow', 'yesterday',
])

/** True when the stripped text is 1–3 proper-noun-shaped tokens — the shape of
 *  a bare customer name ("Sampada", "Sampada Neupane"). */
function looksLikeLoneName(stripped: string): boolean {
  const tokens = stripped.split(/\s+/u).filter((t) => t.length > 0)
  if (tokens.length < 1 || tokens.length > 3) return false
  return tokens.every(
    (t) => PROPER_NAME_TOKEN.test(t) && !CAPITALISED_NOISE.has(t.toLowerCase()),
  )
}

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

  // A bare name-shaped message is a real customer reference, not noise —
  // the terse thread-header pattern ("Sampada" with detail in the replies).
  if (looksLikeLoneName(stripped)) return false

  // Fewer than two real words (≥2 letters) → reactions, acks, lone emoji —
  // never enough signal to identify a customer matter.
  const words = stripped.split(/\s+/u).filter((w) => /\p{L}{2,}/u.test(w))
  if (words.length < 2) return true
  if (stripped.length < 8) return true
  return false
}
