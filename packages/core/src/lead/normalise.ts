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
  /** Request headers used as fallbacks for url / referrer / domain. */
  headers?: { origin?: string | null; referer?: string | null; host?: string | null }
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
  return null
}

/** Best-effort E.164. Confident only for +, 00, and UK 0-prefixed numbers. */
export function normalisePhone(input: string): { e164: string | null; display: string } {
  const display = input.trim()
  const cleaned = display.replace(/[^\d+]/gu, '')
  if (E164_RE.test(cleaned)) return { e164: cleaned, display }
  if (cleaned.startsWith('00')) {
    const candidate = '+' + cleaned.slice(2)
    if (E164_RE.test(candidate)) return { e164: candidate, display }
  }
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    const candidate = '+44' + cleaned.slice(1)
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
        !assigned.has(e.rawKey) && !isNoise(e.key) && PHONE_RE.test(e.value.replace(/\s/gu, '')),
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
        e.value.length <= 60 &&
        /^[\p{L}][\p{L}'.\- ]+$/u.test(e.value) &&
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
