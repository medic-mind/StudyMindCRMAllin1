// Duplicate-contact clustering for the cleanup tool (§3 — humans confirm each
// merge; this only SURFACES candidates). Two contacts are "the same person"
// when they share a normalised email OR a phone (compared on the last-9-digit
// suffix, so "+447700900111" and "07700900111" collide). Sharing is
// transitive — A shares email with B, B shares phone with C → {A,B,C} is one
// cluster — so we union-find across both keys.
//
// Pure: the tRPC procedure feeds the rows in and acts on the clusters.

export interface DupContactRow {
  id: string
  email: string | null
  phoneE164: string | null
}

/** Normalised email key (trim + lowercase), or null. */
export function emailKey(email: string | null | undefined): string | null {
  if (!email) return null
  const k = email.trim().toLowerCase()
  return k === '' ? null : k
}

/** Last-9-digit phone key — format-insensitive across +44/0/country code. */
export function phoneKey(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/gu, '')
  if (digits.length < 9) return null
  return digits.slice(-9)
}

/**
 * Cluster contacts that are duplicates of one another. Returns groups of 2+
 * ids; a singleton (no shared key) is not a duplicate and is omitted. Group
 * order and within-group order both follow the input order, so a caller that
 * feeds rows oldest-first gets oldest-first members (the default survivor).
 */
export function clusterDuplicates(rows: ReadonlyArray<DupContactRow>): string[][] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // Path-compress.
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const r of rows) if (!parent.has(r.id)) parent.set(r.id, r.id)

  const firstByEmail = new Map<string, string>()
  const firstByPhone = new Map<string, string>()
  for (const r of rows) {
    const ek = emailKey(r.email)
    if (ek) {
      const seen = firstByEmail.get(ek)
      if (seen) union(seen, r.id)
      else firstByEmail.set(ek, r.id)
    }
    const pk = phoneKey(r.phoneE164)
    if (pk) {
      const seen = firstByPhone.get(pk)
      if (seen) union(seen, r.id)
      else firstByPhone.set(pk, r.id)
    }
  }

  // Group by root, preserving input order within each group.
  const groups = new Map<string, string[]>()
  for (const r of rows) {
    const root = find(r.id)
    const g = groups.get(root) ?? []
    g.push(r.id)
    groups.set(root, g)
  }
  return [...groups.values()].filter((g) => g.length >= 2)
}
