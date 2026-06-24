// Gmail folder/view ↔ label mapping (ADR 0021 Phase 5 — label-mirror).
//
// The goal: /mail shows EXACTLY what Gmail shows. Gmail has no "folders" — every
// view is a query over labels (Inbox = has INBOX, Spam = has SPAM, the Primary
// tab = INBOX without a non-personal category, …). So instead of re-deriving
// membership from the CRM's lossy `status` enum, we store the thread's full
// current Gmail label-id set on `Conversation.gmailLabelIds` and derive each
// folder/tab from it with the SAME predicates Gmail uses.
//
// Pure + unit-tested: the semantics are pinned here, independent of Prisma, and
// the Prisma `where` builder is generated from the same specs so the matcher and
// the query can never drift.

// -----------------------------------------------------------------------------
// Gmail label vocabulary.
// -----------------------------------------------------------------------------

/** Gmail's category-tab labels (the inbox tabs). CATEGORY_PERSONAL is the
 *  Primary tab and is therefore NOT in this "non-primary" set. */
export const GMAIL_NONPRIMARY_CATEGORIES = [
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
] as const

// -----------------------------------------------------------------------------
// Folder keys. These are the values /mail's rail + tab strip filter on.
// -----------------------------------------------------------------------------

export const GMAIL_FOLDERS = [
  // Inbox + its Gmail category tabs.
  'inbox', // the whole Inbox (every tab) — has INBOX
  'primary', // Primary tab — INBOX without a non-personal category
  'social',
  'promotions',
  'updates',
  'forums',
  // The rest of Gmail's left rail.
  'unread',
  'starred',
  'snoozed',
  'important',
  'sent',
  'spam',
  'all', // All Mail — everything except Spam + Trash
  'archived', // not in Inbox/Spam/Trash (Gmail "Archive")
  'trash',
] as const

export type GmailFolder = (typeof GMAIL_FOLDERS)[number]

/** A folder is "matched" when the thread's label set contains ALL of `all` and
 *  NONE of `none`. */
interface FolderSpec {
  all: readonly string[]
  none: readonly string[]
}

const FOLDER_SPECS: Record<GmailFolder, FolderSpec> = {
  inbox: { all: ['INBOX'], none: [] },
  primary: { all: ['INBOX'], none: GMAIL_NONPRIMARY_CATEGORIES },
  social: { all: ['INBOX', 'CATEGORY_SOCIAL'], none: [] },
  promotions: { all: ['INBOX', 'CATEGORY_PROMOTIONS'], none: [] },
  updates: { all: ['INBOX', 'CATEGORY_UPDATES'], none: [] },
  forums: { all: ['INBOX', 'CATEGORY_FORUMS'], none: [] },
  unread: { all: ['UNREAD'], none: ['TRASH', 'SPAM'] },
  starred: { all: ['STARRED'], none: ['TRASH', 'SPAM'] },
  snoozed: { all: ['SNOOZED'], none: ['TRASH'] },
  important: { all: ['IMPORTANT'], none: ['TRASH', 'SPAM'] },
  sent: { all: ['SENT'], none: ['TRASH'] },
  spam: { all: ['SPAM'], none: [] },
  all: { all: [], none: ['SPAM', 'TRASH'] },
  archived: { all: [], none: ['INBOX', 'SPAM', 'TRASH'] },
  trash: { all: ['TRASH'], none: [] },
}

/**
 * Pure membership test: does a thread carrying `labelIds` belong in `folder`?
 * The single source of truth for the folder semantics; the Prisma builder below
 * is generated from the same specs.
 */
export function gmailFolderMatches(
  labelIds: readonly string[],
  folder: GmailFolder,
): boolean {
  const set = new Set(labelIds)
  const spec = FOLDER_SPECS[folder]
  if (!spec) return false
  for (const l of spec.all) if (!set.has(l)) return false
  for (const l of spec.none) if (set.has(l)) return false
  return true
}

// -----------------------------------------------------------------------------
// Legacy fallback. Heads synced before `gmailLabelIds` existed have an empty
// set; they must not vanish before the resync-heal converges them, so for those
// rows we fall back to the old status/flag columns. Only folders with a sensible
// pre-label meaning get a fallback — the new Gmail-native folders (sent,
// important, the category tabs, snoozed) simply stay empty for legacy rows until
// healed, which is correct (we never had that data before).
// -----------------------------------------------------------------------------

type LegacyWhere = Record<string, unknown>

const LEGACY_WHERE: Partial<Record<GmailFolder, LegacyWhere>> = {
  inbox: { status: 'open', isTrashed: false },
  primary: { status: 'open', isTrashed: false },
  unread: { unreadCount: { gt: 0 }, isTrashed: false },
  starred: { isStarred: true, isTrashed: false },
  archived: { status: 'archived', isTrashed: false },
  spam: { status: 'spam' },
  all: { isTrashed: false },
  trash: { isTrashed: true },
}

// -----------------------------------------------------------------------------
// Prisma `where` builder. Returns a fragment to AND into the email-head query.
//
// Two branches OR'd together:
//   1. label branch — synced heads (gmailLabelIds non-empty) matched by the
//      Gmail-native predicate, so /mail mirrors Gmail exactly;
//   2. legacy branch — un-healed heads (gmailLabelIds empty) matched by the old
//      status/flag columns, so nothing disappears mid-migration.
// -----------------------------------------------------------------------------

/** Build the label-branch AND fragment for a folder (synced heads only). */
function labelBranch(folder: GmailFolder): Record<string, unknown> {
  const spec = FOLDER_SPECS[folder]
  const and: unknown[] = [
    // Only synced heads participate in the Gmail-native branch.
    { NOT: { gmailLabelIds: { isEmpty: true } } },
    ...spec.all.map((l) => ({ gmailLabelIds: { has: l } })),
  ]
  if (spec.none.length > 0) {
    and.push({ NOT: { gmailLabelIds: { hasSome: [...spec.none] } } })
  }
  return { AND: and }
}

/**
 * Prisma `where` fragment selecting the email heads in `folder`. AND this into
 * the per-account / cursor query; never the sole `where` (it owns an `OR`).
 */
export function buildGmailFolderWhere(folder: GmailFolder): Record<string, unknown> {
  const branches: unknown[] = [labelBranch(folder)]
  const legacy = LEGACY_WHERE[folder]
  if (legacy) {
    // Legacy heads have an empty label set; gate the old predicate on that so a
    // healed head is never matched twice.
    branches.push({ AND: [{ gmailLabelIds: { isEmpty: true } }, legacy] })
  }
  return { OR: branches }
}

/**
 * Apply an add/remove delta to a Gmail label-id set, returning a new set (order
 * preserved, de-duplicated). Used by the CRM-side actions (archive/star/trash/
 * read/label) to keep `Conversation.gmailLabelIds` consistent with the action
 * the moment it's taken, so the thread moves folder immediately — before the
 * next sync re-reads Gmail. Mirrors what Gmail does to the labels server-side.
 */
export function mutateLabelSet(
  current: readonly string[],
  delta: { add?: readonly string[]; remove?: readonly string[] },
): string[] {
  const removeSet = new Set(delta.remove ?? [])
  const out: string[] = []
  const seen = new Set<string>()
  for (const l of current) {
    if (removeSet.has(l) || seen.has(l)) continue
    seen.add(l)
    out.push(l)
  }
  for (const l of delta.add ?? []) {
    if (seen.has(l)) continue
    seen.add(l)
    out.push(l)
  }
  return out
}

/** Folders that are Gmail inbox category tabs (rendered as the tab strip). */
export const GMAIL_INBOX_TABS: ReadonlyArray<{ key: GmailFolder; label: string }> = [
  { key: 'primary', label: 'Primary' },
  { key: 'social', label: 'Social' },
  { key: 'promotions', label: 'Promotions' },
  { key: 'updates', label: 'Updates' },
  { key: 'forums', label: 'Forums' },
]

/** Default Gmail system labels every account has, so the folder rail can show a
 *  faithful set even before the first sync populates per-thread label data. */
export const GMAIL_SYSTEM_LABEL_IDS = [
  'INBOX',
  'SENT',
  'DRAFT',
  'SPAM',
  'TRASH',
  'STARRED',
  'UNREAD',
  'IMPORTANT',
  'SNOOZED',
  'CHAT',
  'CATEGORY_PERSONAL',
  ...GMAIL_NONPRIMARY_CATEGORIES,
] as const
