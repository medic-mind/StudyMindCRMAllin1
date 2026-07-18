// Own-brand guard for Slack matching (ADR 0043). Every call summary the team
// posts ends with the brand the customer enquired about ("… Medic Mind",
// "… Oxbridge Mind"), and internal emails (info@medicmind.co.uk) appear in
// message bodies. Left unguarded, those tokens are name/email candidates like
// any other and can hijack a match — filing a customer mention onto a brand
// B2B account, or naming an auto-created contact "Medic Mind". The guard
// resolves the live brand catalogue (Company + BrandDomainRule, ADR 0023) with
// a seed fallback, cached in-process, and the ingest filters candidates
// through it.

import { db } from '@studymind/db'

/** Brands that must never be mistaken for a customer, even before the DB
 *  catalogue is seeded. Lower-case. */
const SEED_BRAND_NAMES = [
  'studymind',
  'study mind',
  'medic mind',
  'medicmind',
  'oxbridge mind',
  'oxbridgemind',
  'career camps',
  'medi platform',
] as const

const SEED_BRAND_DOMAINS = ['studymind.co.uk', 'medicmind.co.uk', 'oxbridgemind.co.uk'] as const

export interface OwnBrands {
  names: ReadonlySet<string>
  domains: readonly string[]
}

const CACHE_TTL_MS = 10 * 60_000
let cache: { brands: OwnBrands; loadedAt: number } | null = null

/** The current own-brand names + email domains. DB-backed (Company names +
 *  BrandDomainRule patterns) so a new brand needs no code change; falls back
 *  to the seeds if the read fails. Cached ~10 min per process. */
export async function loadOwnBrands(): Promise<OwnBrands> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.brands
  const names = new Set<string>(SEED_BRAND_NAMES)
  const domains = new Set<string>(SEED_BRAND_DOMAINS)
  try {
    const [companies, rules] = await Promise.all([
      db.company.findMany({ where: { archivedAt: null }, select: { name: true } }),
      db.brandDomainRule.findMany({ where: { active: true }, select: { pattern: true } }),
    ])
    for (const c of companies) {
      const n = c.name.trim().toLowerCase()
      if (n) names.add(n)
    }
    for (const r of rules) {
      const d = r.pattern.trim().toLowerCase()
      if (d) domains.add(d)
    }
  } catch {
    // Seeds only — the guard must never block ingestion.
  }
  const brands: OwnBrands = { names, domains: [...domains] }
  cache = { brands, loadedAt: Date.now() }
  return brands
}

/** Test seam. */
export function resetOwnBrandsCache(): void {
  cache = null
}

export function isOwnBrandName(name: string, brands: OwnBrands): boolean {
  return brands.names.has(name.trim().toLowerCase())
}

/** True for an email on one of our own domains (info@medicmind.co.uk) — a
 *  routing artefact in the message, never the customer's identity. */
export function isOwnBrandEmail(email: string, brands: OwnBrands): boolean {
  const host = email.trim().toLowerCase().split('@')[1] ?? ''
  if (!host) return false
  return brands.domains.some((d) => host === d || host.endsWith(`.${d}`))
}
