// Rule-based contact-name extraction from message text. CLAUDE.md §11.
//
// Step 2 of the name-resolution waterfall (cheapest first):
//   1. the name Trengo holds on the ticket contact (free, exact)
//   2. THIS — deterministic patterns over the customer's own inbound
//      messages ("my name is…", "this is…", sign-offs) (free)
//   3. the contact_name_extraction AI mini-task (paid, LAST)
//   4. display fallback: the contact's phone / email — never "Unnamed".
//
// Conservative by design: a wrong name on a contact is worse than no name
// (§3 — we only ever fill blanks), so every candidate is validated as
// name-shaped and screened against common false-positive openers
// ("I'm interested…", "this is regarding…").

/** Words that follow "I'm / this is" in normal sentences but are never
 *  names. Lowercase compare on the first captured token. */
const NOT_NAME_OPENERS = new Set([
  'interested',
  'looking',
  'calling',
  'enquiring',
  'inquiring',
  'asking',
  'writing',
  'emailing',
  'messaging',
  'texting',
  'contacting',
  'regarding',
  'about',
  'sorry',
  'afraid',
  'happy',
  'glad',
  'sure',
  'unsure',
  'unable',
  'available',
  'unavailable',
  'keen',
  'wondering',
  'hoping',
  'trying',
  'going',
  'getting',
  'still',
  'also',
  'just',
  'now',
  'currently',
  'already',
  'definitely',
  'really',
  'very',
  'quite',
  'so',
  'not',
  'no',
  'yes',
  'ok',
  'okay',
  'the',
  'a',
  'an',
  'my',
  'his',
  'her',
  'their',
  'mum',
  'mom',
  'dad',
  'urgent',
  'following',
  'checking',
  'chasing',
  'confirming',
  'cancelling',
  'canceling',
  'rescheduling',
  'booking',
  'free',
  'busy',
  'away',
  'back',
  'here',
  'there',
  'new',
  'old',
])

/** Sign-off words that introduce a name on the same or the following line.
 *  Matched anywhere in a line ("See you then. Kind regards, Amir") — the
 *  remainder of the line (or the next line) is the name candidate. */
const SIGN_OFF_INLINE =
  /\b(?:many\s+thanks|thanks\s+again|thank\s+you|thanks|best\s+wishes|best\s+regards|kind\s+regards|warm\s+regards|regards|cheers|sincerely|yours\s+truly)\b[,!. ]*(.*)$/i

/** One name token: starts with an uppercase letter, then letters with
 *  optional internal hyphen/apostrophe. "Jo", "O'Brien", "Anne-Marie". */
const NAME_TOKEN = /^[A-Z][a-zA-Z]*(?:['’-][A-Za-z]+)*$/

const STATEMENT_PATTERNS: RegExp[] = [
  /\bmy\s+name(?:'s|\s+is)\s+([^.,!\n;:]{2,60})/i,
  /\bthis\s+is\s+([^.,!\n;:]{2,60})/i,
  /\bi\s*(?:am|'m)\s+([^.,!\n;:]{2,60})/i,
  /\bname\s*[:-]\s*([^.,!\n;:]{2,60})/i,
  /\bit'?s\s+([^.,!\n;:]{2,60})\s+here\b/i,
]

/**
 * Validate a raw capture as a plausible person name: 1–4 tokens, each
 * name-shaped, first token not a known sentence-opener. Returns the cleaned
 * name or null. Strict — the WHOLE string must be the name (sign-off lines,
 * signature lines).
 */
export function validateNameCandidate(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  if (cleaned.length < 2 || cleaned.length > 40) return null
  const tokens = cleaned.split(' ')
  if (tokens.length === 0 || tokens.length > 4) return null
  const first = tokens[0]!.toLowerCase().replace(/[^a-z]/g, '')
  if (NOT_NAME_OPENERS.has(first)) return null
  for (const t of tokens) {
    if (!NAME_TOKEN.test(t)) return null
    if (t.length > 20) return null
  }
  return tokens.join(' ')
}

/**
 * Lenient variant for mid-sentence captures ("my name is Sarah Jones and I
 * need help"): take the LEADING run of name-shaped tokens (max 4) and stop
 * at the first word that isn't one ("and", "calling", digits…). The opener
 * screen still applies. Exported for tests.
 */
export function namePrefixCandidate(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  const taken: string[] = []
  for (const w of cleaned.split(' ')) {
    if (taken.length === 4) break
    if (!NAME_TOKEN.test(w) || w.length > 20) break
    taken.push(w)
  }
  if (taken.length === 0) return null
  const first = taken[0]!.toLowerCase().replace(/[^a-z]/g, '')
  if (NOT_NAME_OPENERS.has(first)) return null
  const name = taken.join(' ')
  return name.length >= 2 && name.length <= 40 ? name : null
}

/** Extract a name from one message body, or null. Exported for tests. */
export function extractNameFromMessage(body: string): string | null {
  // Statement patterns anywhere in the text. Lenient prefix take — the
  // capture often trails into the sentence ("…Sarah Jones and I need help").
  for (const pattern of STATEMENT_PATTERNS) {
    const m = pattern.exec(body)
    if (m?.[1]) {
      const candidate = namePrefixCandidate(m[1])
      if (candidate) return candidate
    }
  }

  // Sign-offs: "… Kind regards, Amir" anywhere on a line, or a closing word
  // with the name on the next non-empty line (classic email signature).
  // Strict validation — the remainder must BE the name, nothing else.
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  for (let i = 0; i < lines.length; i += 1) {
    const m = SIGN_OFF_INLINE.exec(lines[i]!)
    if (!m) continue
    const sameLine = (m[1] ?? '').trim()
    if (sameLine) {
      const candidate = validateNameCandidate(sameLine)
      if (candidate) return candidate
      continue
    }
    const nextLine = lines[i + 1]
    if (nextLine) {
      const candidate = validateNameCandidate(nextLine)
      if (candidate) return candidate
    }
  }
  return null
}

/**
 * Walk the customer's inbound messages (oldest first — people introduce
 * themselves early) and return the first confidently-extracted name.
 */
export function extractNameFromMessages(bodies: ReadonlyArray<string>): string | null {
  for (const body of bodies) {
    if (typeof body !== 'string' || body.trim() === '') continue
    const name = extractNameFromMessage(body)
    if (name) return name
  }
  return null
}
