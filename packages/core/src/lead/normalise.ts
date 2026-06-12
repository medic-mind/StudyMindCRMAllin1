// Dynamic lead normaliser (ADR 0023).
//
// Turns ANY Contact-Form-7 / JSON / form-encoded payload into a clean
// NormalisedLead without depending on specific field ids. CF7 forms vary
// wildly (`text-618`, `tel-146`, `your-email`, `webhook:name`, …) so we detect
// each field's *role* from four signals, in order:
//   1. an explicit `webhook:<role>` mapping (the user's forms use these),
//   2. a known name synonym (`your-email`, `phone-number`, …),
//   3. the CF7 type prefix (`tel-146` → phone, `email-12` → email),
//   4. the value itself (looks like an email / phone / long message).
//
// Then we lift landing-page intelligence (domain, slug, form title, UTM) from
// hidden fields, explicit meta, or request headers. Pure + deterministic.

import type { NormalisedLead, Utm } from './types'

export interface RawLeadInput {
  /** Flattened form fields (CF7 names → values), merged from JSON or urlencoded. */
  fields: Record<string, unknown>
  /** Explicit metadata when the integration provides it (preferred). */
  meta?: {
    source?: string
    url?: string
    referrer?: string
    formTitle?: string
    formId?: string
    domain?: string
  }
  /** Request headers used as fallbacks for url / referrer / domain, plus the
   * client IP (first X-Forwarded-For hop) for country derivation. */
  headers?: {
    origin?: string | null
    referer?: string | null
    host?: string | null
    ip?: string | null
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const PHONE_RE = /^[+(]?\d[\d\s().-]{6,}$/u
const E164_RE = /^\+[1-9]\d{6,14}$/u

const SYNONYMS = {
  email: [
    'email',
    'e-mail',
    'mail',
    'email-address',
    'emailaddress',
    'your-email',
    'user-email',
    'contact-email',
  ],
  phone: [
    'phone',
    'tel',
    'telephone',
    'mobile',
    'number',
    'phone-number',
    'mobile-number',
    'contact-number',
    'contact-phone',
    'your-phone',
    'your-tel',
    'your-number',
  ],
  firstName: ['first-name', 'firstname', 'fname', 'first', 'given-name', 'your-first-name'],
  lastName: ['last-name', 'lastname', 'lname', 'surname', 'last', 'family-name', 'your-last-name'],
  parentName: [
    'parent-name',
    'parent',
    'guardian',
    'guardian-name',
    'parent-guardian',
    'your-parent-name',
  ],
  name: [
    'name',
    'full-name',
    'fullname',
    'contact-name',
    'your-name',
    'your-full-name',
    'student-name',
  ],
  message: [
    'message',
    'enquiry',
    'inquiry',
    'comments',
    'comment',
    'question',
    'details',
    'notes',
    'your-message',
    'your-enquiry',
    'your-question',
    'your-details',
    'how-can-we-help',
  ],
  url: [
    'page-url',
    'url',
    'current-url',
    'page',
    'source-url',
    'referring-page',
    'landing-page',
    'wpcf7-page-url',
  ],
  referrer: ['referrer', 'referer', 'http-referer', 'ref'],
  formTitle: ['form-title', 'form-name', 'your-form', 'wpcf7-form-title'],
  formId: ['form-id', 'formid', 'wpcf7', 'wpcf7-unit-tag'],
  // A date/time the enquirer chose — "preferred call time", a booking slot,
  // CF7's [date]/[time]/[datetime] fields. We combine date + time when both
  // are present so a "Tue 3pm" selection lands on the card automatically.
  when: [
    'date',
    'time',
    'datetime',
    'preferred-date',
    'preferred-time',
    'preferred-datetime',
    'preferred-call-time',
    'preferred-time-to-call',
    'best-time-to-call',
    'best-time',
    'call-time',
    'callback-time',
    'appointment',
    'appointment-time',
    'slot',
    'booking-time',
    'your-date',
    'your-time',
    'your-preferred-time',
  ],
  // A country field — name or ISO code. Used for phone dial-code composing.
  country: ['country', 'your-country', 'country-code', 'country-of-residence', 'nationality'],
  // The visitor's IP, when the form forwards it (CF7 `_remote_ip`, hidden
  // fields). normKey turns `_remote_ip` into `remote-ip`.
  ip: ['ip', 'remote-ip', 'user-ip', 'client-ip', 'visitor-ip', 'ip-address', 'user-ip-address', 'remote-addr'],
  // A subject/topic dropdown — "Which course?", "Subject", "Interested in".
  subject: [
    'subject',
    'course',
    'courses',
    'interested-in',
    'interest',
    'which-course',
    'which-courses',
    'course-interest',
    'enquiry-type',
    'enquiry-subject',
    'topic',
    'service',
    'your-subject',
    'your-course',
    'which-service',
  ],
} as const

type Role = keyof typeof SYNONYMS

// Matched against the *normalised* key (underscores → dashes, dashes trimmed),
// so `_wpnonce` arrives here as `wpnonce`. `wpcf7` is intentionally NOT noise —
// it carries the CF7 form id, which we consume as formId.
const NOISE_PREFIXES = ['wpnonce', 'g-recaptcha', 'wp-http-referer']

function toStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(toStr).filter(Boolean).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v).trim()
}

/** Lower-case, strip a leading `webhook:` mapping prefix, normalise separators. */
function normKey(key: string): string {
  let k = key.trim().toLowerCase()
  if (k.startsWith('webhook:')) k = k.slice('webhook:'.length)
  return k.replace(/[\s_]+/gu, '-').replace(/^-+|-+$/gu, '')
}

/** CF7 fields are `<type>-<digits>` (`text-618`, `tel-146`). Return the type. */
function typePrefix(normalisedKey: string): string {
  const m = /^([a-z][a-z-]*?)-\d+$/u.exec(normalisedKey)
  return m ? m[1]! : normalisedKey
}

function isNoise(normalisedKey: string): boolean {
  return NOISE_PREFIXES.some((p) => normalisedKey.startsWith(p))
}

// Product / free-resource shaped fields — used to stop the name value-sniff
// picking up "GAMSAT Book" etc. as the enquirer's name (§16).
const RESOURCE_KEY_RE =
  /(product|resource|course|subject|topic|item|title|book|guide|download|file|document|package|pack|exam)/u
const RESOURCE_VALUE_RE =
  /\b(books?|e-?books?|guides?|guidebooks?|downloads?|resources?|packs?|papers?|webinars?|courses?|samples?|sheets?|notes?|bundles?|free|ucat|gamsat|bmat|ukcat|plab|lnat|imat|esat|mcat|tsa|nsaa|engaa|questions?|quiz(?:zes)?|q-?banks?|mocks?|flashcards?|worksheets?|revision|syllabus|past\s+papers?|interview|tutoring|tuition|gcse|igcse|a-?levels?|11\+)\b/iu

/** True when a value is a product/resource title, not a person ("PLAB
 *  Questions", "GAMSAT Book") — used by the lead pipeline and the retro
 *  repair job to rename such contacts after their email instead. */
export function isResourceShapedName(name: string): boolean {
  return RESOURCE_VALUE_RE.test(name)
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u

function inList(list: readonly string[], key: string): boolean {
  return list.includes(key)
}

interface Entry {
  rawKey: string
  key: string
  type: string
  value: string
}

function roleForKey(key: string, type: string): Role | null {
  for (const role of Object.keys(SYNONYMS) as Role[]) {
    if ((SYNONYMS[role] as readonly string[]).includes(key)) return role
  }
  // CF7 type prefixes only disambiguate the unambiguous channels.
  if (type === 'email') return 'email'
  if (type === 'tel') return 'phone'
  if (type === 'textarea') return 'message'
  // CF7 [date]/[time]/[datetime] (and common plugin variants) → the when slot.
  if (type === 'date' || type === 'time' || type === 'datetime' || type === 'datetime-local')
    return 'when'
  return null
}

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/u
const DMY_RE = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/u
const TIME_RE = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/iu
const TIME_AMPM_RE = /\b(\d{1,2})\s*(am|pm)\b/iu

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Extract a "YYYY-MM-DD" date from free text. UK reading (D/M/Y) for the
 * ambiguous slash form. Returns null when no plausible date is present. */
function extractDate(raw: string): string | null {
  const iso = ISO_DATE_RE.exec(raw)
  if (iso) {
    const [, y, m, d] = iso
    return `${y}-${m}-${d}`
  }
  const dmy = DMY_RE.exec(raw)
  if (dmy) {
    const d = dmy[1]!
    const m = dmy[2]!
    const rawY = dmy[3]!
    const y = rawY.length === 2 ? '20' + rawY : rawY
    const dd = Number(d)
    const mm = Number(m)
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      return `${y}-${pad2(mm)}-${pad2(dd)}`
    }
  }
  return null
}

/** Extract a 24h "HH:mm" time from free text (handles am/pm). Null if none. */
function extractTime(raw: string): string | null {
  const t = TIME_RE.exec(raw)
  if (t) {
    let h = Number(t[1])
    const min = Number(t[2])
    const ap = t[3]?.toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return `${pad2(h)}:${pad2(min)}`
  }
  const ta = TIME_AMPM_RE.exec(raw)
  if (ta) {
    let h = Number(ta[1])
    const ap = ta[2]!.toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h >= 0 && h <= 23) return `${pad2(h)}:00`
  }
  return null
}

/**
 * Assemble a Europe/London wall-clock "YYYY-MM-DDTHH:mm" (or bare date) from
 * the raw `when`-role values found on the form. CF7 often splits date and time
 * into two fields, so we scan all of them: first a date, then a time, and
 * combine. Returns null when no usable date is present (a lone time with no
 * date is not actionable on a calendar).
 */
export function extractPreferredWhen(values: string[]): string | null {
  let date: string | null = null
  let time: string | null = null
  for (const v of values) {
    if (!date) date = extractDate(v)
    if (!time) time = extractTime(v)
  }
  if (!date) return null
  return time ? `${date}T${time}` : date
}

/**
 * Best-effort E.164. Confident for: `+…`, `00…` international, UK
 * `0…`-prefixed (10–11 digits), bare `44…` country-coded, and bare UK
 * mobiles typed without the leading 0 (`7xxx xxx xxx`). Anything else
 * returns e164 null — the caller keeps the as-typed value so the number
 * is never silently lost (live bug: a number the strict rules rejected
 * vanished from the contact and the pipeline card entirely).
 */
export function normalisePhone(input: string): { e164: string | null; display: string } {
  const display = input.trim()
  const cleaned = display.replace(/[^\d+]/gu, '')
  if (E164_RE.test(cleaned)) return { e164: cleaned, display }
  if (cleaned.startsWith('00')) {
    const candidate = '+' + cleaned.slice(2)
    if (E164_RE.test(candidate)) return { e164: candidate, display }
  }
  // UK national format: 0 + 9–10 digits (mobiles 11 total, some landlines 10).
  if (cleaned.startsWith('0') && (cleaned.length === 10 || cleaned.length === 11)) {
    const candidate = '+44' + cleaned.slice(1)
    if (E164_RE.test(candidate)) return { e164: candidate, display }
  }
  // Country code typed without the +/00 (e.g. "44 7700 900123").
  if (cleaned.startsWith('44') && cleaned.length >= 11 && cleaned.length <= 13) {
    const candidate = '+' + cleaned
    if (E164_RE.test(candidate)) return { e164: candidate, display }
  }
  // UK mobile with the leading 0 dropped (e.g. "7700 900123").
  if (cleaned.startsWith('7') && cleaned.length === 10) {
    const candidate = '+44' + cleaned
    if (E164_RE.test(candidate)) return { e164: candidate, display }
  }
  return { e164: null, display }
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80)
}

function parseUrl(url: string | null): { domain: string | null; slug: string | null } {
  if (!url) return { domain: null, slug: null }
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`)
    const domain = u.host.replace(/^www\./u, '').toLowerCase() || null
    const path = u.pathname.replace(/^\/+|\/+$/gu, '').toLowerCase()
    return { domain, slug: path || null }
  } catch {
    return { domain: null, slug: null }
  }
}

function collectUtm(fields: Record<string, string>, url: string | null): Utm | null {
  const utm: Record<string, string> = {}
  const keys = ['source', 'medium', 'campaign', 'term', 'content'] as const
  for (const k of keys) {
    const v = fields[`utm_${k}`] ?? fields[`utm-${k}`]
    if (v) utm[k] = v
  }
  if (url) {
    try {
      const u = new URL(url.includes('://') ? url : `https://${url}`)
      for (const k of keys) {
        if (!utm[k]) {
          const v = u.searchParams.get(`utm_${k}`)
          if (v) utm[k] = v
        }
      }
    } catch {
      // ignore unparseable url
    }
  }
  return Object.keys(utm).length > 0 ? (utm as Utm) : null
}

export function normaliseLead(input: RawLeadInput): NormalisedLead {
  const meta = input.meta ?? {}
  const headers = input.headers ?? {}

  // Build entries (stringified, non-empty), de-noised key map for lookups.
  const entries: Entry[] = []
  const byKey = new Map<string, string>()
  for (const [rawKey, rawVal] of Object.entries(input.fields)) {
    const value = toStr(rawVal)
    const key = normKey(rawKey)
    if (!byKey.has(key) && value) byKey.set(key, value)
    if (!value) continue
    entries.push({ rawKey, key, type: typePrefix(key), value })
  }

  const assigned = new Set<string>() // rawKeys consumed by a first-class field
  const found: Partial<Record<Role, string>> = {}

  // Pass 1 — explicit mapping / synonym / CF7 type prefix.
  for (const e of entries) {
    if (isNoise(e.key)) continue
    const role = roleForKey(e.key, e.type)
    if (role && found[role] === undefined) {
      found[role] = e.value
      assigned.add(e.rawKey)
    }
  }

  // Pass 2 — value heuristics for the channels that still matter.
  if (found.email === undefined) {
    const hit = entries.find((e) => !assigned.has(e.rawKey) && EMAIL_RE.test(e.value))
    if (hit) {
      found.email = hit.value
      assigned.add(hit.rawKey)
    }
  }
  if (found.phone === undefined) {
    const hit = entries.find(
      (e) =>
        !assigned.has(e.rawKey) &&
        !isNoise(e.key) &&
        // A dotted IPv4 ("198.51.100.24") is digits-and-dots too — never a
        // phone number; it stays available for the clientIp sniff below.
        !IPV4_RE.test(e.value.trim()) &&
        PHONE_RE.test(e.value.replace(/\s/gu, '')),
    )
    if (hit) {
      found.phone = hit.value
      assigned.add(hit.rawKey)
    }
  }
  if (found.message === undefined) {
    // Longest remaining free-text value that reads like prose.
    const candidates = entries
      .filter((e) => !assigned.has(e.rawKey) && !isNoise(e.key))
      .filter((e) => e.value.length >= 25 || e.value.split(/\s+/u).length >= 4)
      // A bare URL is never the enquiry message (hidden page-url style fields
      // on unknown keys were being picked up as the "message").
      .filter((e) => !/^https?:\/\/\S+$/u.test(e.value))
      .sort((a, b) => b.value.length - a.value.length)
    if (candidates[0]) {
      found.message = candidates[0].value
      assigned.add(candidates[0].rawKey)
    }
  }
  if (found.name === undefined && found.firstName === undefined) {
    const hit = entries.find(
      (e) =>
        !assigned.has(e.rawKey) &&
        !isNoise(e.key) &&
        // A product/resource field can never be the person's name — a
        // free-download form ("GAMSAT Book") must not christen the contact
        // after the freebie. Guard on both the key and the value; when no
        // name survives, the onboarding falls back to the email address.
        !RESOURCE_KEY_RE.test(e.key) &&
        e.value.length <= 60 &&
        /^[\p{L}][\p{L}'.\- ]+$/u.test(e.value) &&
        !RESOURCE_VALUE_RE.test(e.value) &&
        !EMAIL_RE.test(e.value),
    )
    if (hit) {
      found.name = hit.value
      assigned.add(hit.rawKey)
    }
  }

  // Compose name parts.
  let name = found.name ?? null
  let firstName = found.firstName ?? null
  let lastName = found.lastName ?? null
  if (!name && (firstName || lastName)) {
    name = [firstName, lastName].filter(Boolean).join(' ') || null
  } else if (name && !firstName && !lastName) {
    const parts = name.split(/\s+/u)
    firstName = parts[0] ?? null
    lastName = parts.length > 1 ? parts.slice(1).join(' ') : null
  }

  // Final person-name guard: even an EXPLICITLY-mapped name field can carry
  // the product on freebie forms ("PLAB Questions", "LNAT Questions" typed
  // into the name input, or wired via webhook mapping). A resource-shaped
  // name is dropped entirely so onboarding names the contact after their
  // email instead — never after the page they downloaded (§16).
  if (name && RESOURCE_VALUE_RE.test(name)) {
    name = null
    firstName = null
    lastName = null
  }

  // Landing-page intelligence.
  const url =
    meta.url ?? SYNONYMS.url.map((k) => byKey.get(k)).find(Boolean) ?? headers.referer ?? null
  const referrer =
    meta.referrer ??
    SYNONYMS.referrer.map((k) => byKey.get(k)).find(Boolean) ??
    headers.referer ??
    null
  const parsed = parseUrl(url)
  const domain =
    parsed.domain ??
    meta.domain ??
    parseUrl(headers.origin ?? null).domain ??
    (headers.host ? headers.host.replace(/^www\./u, '').toLowerCase() : null)
  const formTitle =
    meta.formTitle ?? SYNONYMS.formTitle.map((k) => byKey.get(k)).find(Boolean) ?? null
  const formId = meta.formId ?? SYNONYMS.formId.map((k) => byKey.get(k)).find(Boolean) ?? null

  // Email + phone tidy-up.
  const email = found.email ? found.email.trim().toLowerCase() : null
  const phoneRes = found.phone ? normalisePhone(found.phone) : null

  // Preferred date/time. CF7 commonly splits date and time into separate
  // fields, both detected as the `when` role — so we collect *every* when-role
  // value (not just the first) and assemble a single instant. Falls back to
  // scanning the message body so "call me Tuesday at 3pm" still lands.
  const whenValues = entries.filter((e) => roleForKey(e.key, e.type) === 'when').map((e) => e.value)
  if (found.message) whenValues.push(found.message)
  const preferredWhen = extractPreferredWhen(whenValues)
  // A subject/topic dropdown selection, if present.
  const requestedSubject = found.subject ? found.subject.trim().slice(0, 120) : null
  // Country (form-selected). Resolved to a dial code downstream.
  const country = found.country ? found.country.trim().slice(0, 80) : null

  // Visitor IP — explicit field first (CF7 `_remote_ip`), else sniff an
  // IP-shaped value. CF7 webhooks are POSTed by the WordPress server, so this
  // beats the transport IP for country geolocation.
  const sniffedIp =
    found.ip ??
    entries.find((e) => !assigned.has(e.rawKey) && !isNoise(e.key) && IPV4_RE.test(e.value.trim()))
      ?.value ??
    null
  const clientIp = sniffedIp ? sniffedIp.trim().slice(0, 45) : null

  // Stringified field map for UTM lookup.
  const fieldStrs: Record<string, string> = {}
  for (const e of entries) fieldStrs[e.key] = e.value
  const utm = collectUtm(fieldStrs, url)

  // Leftover recognised fields → inspector.
  const extraFields: Record<string, string> = {}
  for (const e of entries) {
    if (assigned.has(e.rawKey)) continue
    if (isNoise(e.key)) continue
    if (inList(SYNONYMS.url, e.key)) continue
    if (inList(SYNONYMS.referrer, e.key)) continue
    if (inList(SYNONYMS.formTitle, e.key)) continue
    if (inList(SYNONYMS.formId, e.key)) continue
    if (inList(SYNONYMS.when, e.key)) continue
    if (roleForKey(e.key, e.type) === 'when') continue
    if (e.key.startsWith('utm-') || e.key.startsWith('utm_')) continue
    extraFields[e.rawKey] = e.value
  }

  const source =
    meta.source ??
    `cf7:${domain ?? 'unknown'}/${parsed.slug ?? (formTitle ? slugify(formTitle) : 'form')}`

  return {
    source,
    name,
    firstName,
    lastName,
    email,
    phone: phoneRes?.display ?? null,
    phoneE164: phoneRes?.e164 ?? null,
    message: found.message ?? null,
    parentName: found.parentName ?? null,
    preferredWhen,
    requestedSubject,
    country,
    clientIp,
    landingDomain: domain,
    landingUrl: url,
    landingSlug: parsed.slug,
    formTitle: formTitle ?? null,
    formId: formId ?? null,
    referrer,
    utm,
    extraFields,
  }
}
