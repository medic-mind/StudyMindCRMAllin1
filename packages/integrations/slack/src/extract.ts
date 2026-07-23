// Deterministic contact-signal extraction from Slack message text — runs
// BEFORE any AI spend (cheapest route first; AI is the last resort). The
// team's call-log format ("🇬🇧Leisha Burgess +447359988992 Medic Mind …")
// carries a phone/email verbatim, so most mentions match with zero AI —
// and keep working when the AI provider is down or over budget.

/** A `:emoji:` shortcode (`:gb:`, `:large_purple_circle:`). Shared by the
 *  noise gate and the complaint-draft builder so the two never diverge. */
export const SLACK_EMOJI_CODE_RE = /:[a-z0-9_+-]+:/giu

/** The wall-clock moment of a Slack message from its `ts` ("1784132400.477259"
 *  — UNIX seconds + a uniqueness suffix). One canonical parse, so an archived
 *  Interaction's occurredAt and any time-window rule always agree. */
export function slackTsToDate(ts: string): Date {
  return new Date(Number(ts.split('.')[0] ?? 0) * 1000)
}

/** Unwrap Slack mrkdwn entities to readable text: `<tel:x|y>`/`<mailto:x|y>`
 *  → label, `<url|label>` → label, `<url>` → url, mentions stripped. */
export function slackTextToPlain(text: string): string {
  return text
    .replace(/<(?:tel|mailto):([^>|]+)\|([^>]+)>/giu, '$2')
    .replace(/<(?:tel|mailto):([^>|]+)>/giu, '$1')
    .replace(/<https?:[^>|]+\|([^>]+)>/giu, '$1')
    .replace(/<(https?:[^>|]+)>/giu, '$1')
    .replace(/<[@!][^>]+>/gu, ' ')
    .replace(/<#[^>|]+\|([^>]+)>/gu, '#$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim()
}

export interface ContactSignals {
  email: string | null
  phone: string | null
}

// -----------------------------------------------------------------------------
// Deterministic NAME candidates — the free path used to hard-code `name: null`,
// which made every name-only mention ("Spoke to Aanya Sharma about the mocks")
// AI-only: with no provider key configured it could never link and parked with
// a null candidate the relink cron couldn't rescue. This extractor feeds the
// SAME unambiguous-only matcher the AI path uses (`matchContactByCandidate`,
// take:2 — resolves only when EXACTLY one contact matches, §3), so a wrong
// guess here cannot mislink: it simply matches nobody.
// -----------------------------------------------------------------------------

/** Proper-noun shape: capitalised segments joined by apostrophe/hyphen —
 *  Aanya, O'Brien, Anne-Marie. Deliberately excludes ALL-CAPS acronyms
 *  (UK, GCSE, CRM) and requires ≥2 characters. */
const PROPER_TOKEN = /^(?=.{2,})\p{Lu}\p{Ll}*(?:['’-]\p{Lu}?\p{Ll}+)*$/u

/** Common capitalised words that are never a customer's name on their own —
 *  sentence openers, acks, calendar words. Single-token candidates only;
 *  multi-token runs ("Grace Monday" a real name) are left to the matcher. */
const NAME_STOPWORDS = new Set([
  'thanks', 'thank', 'thankyou', 'cheers', 'ok', 'okay', 'yes', 'no', 'yep', 'nope',
  'done', 'great', 'nice', 'cool', 'perfect', 'brilliant', 'awesome', 'sure',
  'hello', 'hi', 'hey', 'morning', 'afternoon', 'evening', 'welcome', 'sorry',
  'please', 'noted', 'agreed', 'understood', 'update', 'reminder', 'urgent', 'fyi',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'today', 'tomorrow', 'yesterday',
])

/** Bound the matcher round-trips per message. */
const MAX_NAME_CANDIDATES = 5

/**
 * Pull likely person-name candidates out of a Slack message, deterministically.
 * Strategy: maximal runs of proper-noun-shaped tokens. Runs of 2–3 tokens
 * ("Aanya Sharma", "Anne-Marie O'Brien") are the strongest candidates and come
 * first; single tokens count only when they are NOT the message/sentence opener
 * (sentence-start capitalisation) and not a stop word. The unambiguous-only
 * matcher is the real safety — a non-name candidate matches nobody.
 */
export function extractNameCandidates(text: string): string[] {
  const plain = slackTextToPlain(text)
  // Token stream with sentence-boundary markers preserved.
  const rawTokens = plain.split(/\s+/u).filter((t) => t.length > 0)

  const runs: Array<{ tokens: string[]; startsSentence: boolean }> = []
  let current: string[] = []
  let currentStartsSentence = true
  let atSentenceStart = true
  for (const raw of rawTokens) {
    const word = raw.replace(/^[^\p{L}'’-]+|[^\p{L}'’-]+$/gu, '')
    const isProper = PROPER_TOKEN.test(word)
    if (isProper) {
      if (current.length === 0) currentStartsSentence = atSentenceStart
      current.push(word)
    } else if (current.length > 0) {
      runs.push({ tokens: current, startsSentence: currentStartsSentence })
      current = []
    }
    // The next token starts a sentence when this raw token ends one.
    atSentenceStart = /[.!?:;]$/u.test(raw)
    if (isProper && atSentenceStart) {
      // Run broken by terminal punctuation ("…with Aanya. Next…").
      runs.push({ tokens: current, startsSentence: currentStartsSentence })
      current = []
    }
  }
  if (current.length > 0) runs.push({ tokens: current, startsSentence: currentStartsSentence })

  // A message that IS just a name ("Sampada", "Sampada Neupane" as a thread
  // header) has its single run at sentence start by definition — exempt it.
  const wholeMessageIsRun = runs.length === 1 && runs[0]!.tokens.length === rawTokens.length

  const multi: string[] = []
  const single: string[] = []
  for (const run of runs) {
    if (run.tokens.length >= 2 && run.tokens.length <= 3) {
      multi.push(run.tokens.join(' '))
      // A sentence-starting run can absorb a leading verb ("Called Priya
      // Sharma", "Met John Smith", "Rang Bilal Khan") because the capitalised
      // verb looks like a proper noun, so the full run never matches. Emit the
      // run with its first token dropped as an EXTRA rescue candidate while
      // KEEPING the full run — matchContactByCandidate is unambiguous-only, so
      // the extra candidate can never mislink; it only adds a match path (and a
      // real sentence-start name like "Priya Sharma called…" still matches on
      // its full run first).
      if (run.startsSentence && !wholeMessageIsRun) {
        multi.push(run.tokens.slice(1).join(' '))
      }
    } else if (run.tokens.length === 1) {
      const token = run.tokens[0]!
      if (run.startsSentence && !wholeMessageIsRun) continue // "Spoke to…", "Called her…"
      if (NAME_STOPWORDS.has(token.toLowerCase())) continue
      single.push(token)
    }
    // Runs of 4+ proper tokens are headlines/titles, not names — skipped.
  }

  const out: string[] = []
  for (const c of [...multi, ...single]) {
    if (!out.includes(c)) out.push(c)
    if (out.length >= MAX_NAME_CANDIDATES) break
  }
  return out
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/iu
/** A phone-shaped run: optional +, then 9+ digits allowing spaces/()-. */
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/u

/**
 * Pull the first email and/or phone out of a Slack message. Slack often
 * auto-links them (`<tel:+447…|+447…>`, `<mailto:a@b|a@b>`), so the markup
 * forms are read first, then the plain text. A phone needs ≥ 9 digits —
 * shorter runs are order numbers / prices, not diallable numbers.
 */
export function extractContactSignals(text: string): ContactSignals {
  const telMarkup = /<tel:([^>|]+)(?:\|[^>]*)?>/iu.exec(text)?.[1] ?? null
  const mailtoMarkup = /<mailto:([^>|]+)(?:\|[^>]*)?>/iu.exec(text)?.[1] ?? null
  const plain = slackTextToPlain(text)

  const email = mailtoMarkup ?? EMAIL_RE.exec(plain)?.[0] ?? null

  let phone: string | null = null
  const phoneRaw = telMarkup ?? PHONE_RE.exec(plain)?.[0] ?? null
  if (phoneRaw) {
    const digits = phoneRaw.replace(/[^\d+]/gu, '')
    const digitCount = digits.replace(/\D/gu, '').length
    if (digitCount >= 9 && digitCount <= 15) phone = digits
  }

  return { email: email?.trim().toLowerCase() ?? null, phone }
}
