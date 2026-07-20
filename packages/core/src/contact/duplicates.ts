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
  /** Optional — only used by the auto-merge planner to guard shared landlines. */
  name?: string | null
}

/** Normalised email key (trim + lowercase), or null. */
export function emailKey(email: string | null | undefined): string | null {
  if (!email) return null
  const k = email.trim().toLowerCase()
  return k === '' ? null : k
}

/** Normalised name key (lowercase, alphanumerics + single spaces), or null. */
export function nameKey(name: string | null | undefined): string | null {
  if (!name) return null
  const k = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
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

export interface AutoMergePlan {
  /** The kept contact — the oldest in the confident group. */
  survivorId: string
  /** Contacts merged into the survivor (confidently the same person). */
  loserIds: string[]
}

/**
 * Decide which duplicates are safe to merge WITHOUT human review (ADR 0047 —
 * operator-authorised auto-merge). We only auto-merge contacts that are
 * *confidently the same person*:
 *   - they share a normalised email (near-certain — a re-enquiry, a second
 *     record for the same inbox), OR
 *   - they share a phone AND a matching name (a shared family landline alone is
 *     NOT enough — §41.1 — two different people can share it, so the name has
 *     to agree too).
 *
 * Within a raw duplicate cluster we build the "same-person" subgraph from those
 * edges and keep only the component that contains the survivor (the oldest
 * contact, so the longest-lived record and its history survive). Anything in the
 * cluster NOT confidently connected to the survivor — e.g. a phone-only match
 * with a different name — is left out, so it still surfaces on the manual
 * `/contacts/duplicates` review page. Pure: the caller executes the merges.
 */
export function planAutoMerges(rows: ReadonlyArray<DupContactRow>): AutoMergePlan[] {
  const byId = new Map<string, DupContactRow>()
  for (const r of rows) byId.set(r.id, r)

  const plans: AutoMergePlan[] = []
  for (const clusterIds of clusterDuplicates(rows)) {
    const members = clusterIds.map((id) => byId.get(id)!).filter(Boolean)
    if (members.length < 2) continue

    // Union-find over confident same-person edges, scoped to this cluster.
    const parent = new Map<string, string>()
    for (const m of members) parent.set(m.id, m.id)
    const find = (x: string): string => {
      let root = x
      while (parent.get(root) !== root) root = parent.get(root)!
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

    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i]!
        const b = members[j]!
        const ea = emailKey(a.email)
        const sharesEmail = ea !== null && ea === emailKey(b.email)
        const pa = phoneKey(a.phoneE164)
        const na = nameKey(a.name)
        const sharesPhoneAndName =
          pa !== null && pa === phoneKey(b.phoneE164) && na !== null && na === nameKey(b.name)
        if (sharesEmail || sharesPhoneAndName) union(a.id, b.id)
      }
    }

    // Survivor = the oldest member (input is oldest-first). Auto-merge only the
    // members confidently in the survivor's component.
    const survivorId = members[0]!.id
    const survivorRoot = find(survivorId)
    const loserIds = members
      .slice(1)
      .filter((m) => find(m.id) === survivorRoot)
      .map((m) => m.id)
    if (loserIds.length > 0) plans.push({ survivorId, loserIds })
  }
  return plans
}
