// CI check: the permission matrix in CLAUDE.md §20.1 must match the
// canonical grants in packages/core/src/auth/policies.ts.
//
// We treat the code as truth. The script:
//   1. Loads ROLES, ACTIONS, ROLE_GRANTS, ATTRIBUTE_GATED_ACTIONS, AUDIT_REQUIRED_ACTIONS
//      from `@studymind/core/auth/policies`.
//   2. Generates the markdown table that should appear in §20.1.
//   3. Extracts the actual table out of CLAUDE.md and compares.
//   4. Exits 0 on match, 1 on drift (with a diff-style report).
//
// Run: pnpm policy:check
//
// Notes on the canonical encoding (kept simple so the doc stays human-friendly):
//   - "✓"          when role grants the action and no attribute gate.
//   - "✓ (audited)" when audit-required AND the action is one of the few we
//     historically called out in the doc with that suffix
//     (contact.read_minor, safeguarding.read_notes, audit.read for dsl).
//   - "—" when the role does NOT grant the action.
//
// Action keys in the doc: most match policies.ts directly. A few have been
// historically labelled differently (`contact.read (minor)` vs the code's
// `contact.read_minor`, etc); the alias map below keeps the script tolerant
// while still flagging real drift.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ACTIONS,
  ATTRIBUTE_GATED_ACTIONS,
  AUDIT_REQUIRED_ACTIONS,
  ROLE_GRANTS,
  ROLES,
  type Action,
  type Role,
} from '../../packages/core/src/auth/policies'

const REPO_ROOT = resolve(__dirname, '..', '..')
const CLAUDE_MD = resolve(REPO_ROOT, 'CLAUDE.md')

// Mapping from doc-label (left column in CLAUDE.md) to the canonical Action key.
// The doc carries a friendlier wording for a couple of rows — those mappings live
// here. A doc row whose label is not mapped is treated as a literal Action key.
const DOC_LABEL_TO_ACTION: Record<string, Action | { action: Action; suffix?: string }> = {
  'contact.read (non-minor)': 'contact.read',
  'contact.read (minor)': 'contact.read_minor',
  'contact.write': 'contact.write',
  'family.merge': 'family.merge',
  'interaction.create': 'interaction.create',
  'interaction.delete': 'interaction.delete',
  'charge.create_link': 'charge.create_link',
  'charge.refund': 'charge.refund',
  'subscription.cancel': 'subscription.cancel',
  'safeguarding.flag': 'safeguarding.flag',
  'safeguarding.read_notes': 'safeguarding.read_notes',
  'dsar.export': 'dsar.export',
  'audit.read': 'audit.read',
  'settings.write': 'settings.write',
  'user.invite': 'user.invite',
  'user.role.grant_admin': 'user.role.grant_admin',
  'user.role.grant_super_admin': 'user.role.grant_super_admin',
  'user.role.revoke_admin': 'user.role.revoke_admin',
  'secrets.rotate': 'secrets.rotate',
  'tenant.config.write': 'tenant.config.write',
}

function cellFor(role: Role, action: Action): 'granted' | 'denied' {
  return ROLE_GRANTS[role].has(action) ? 'granted' : 'denied'
}

interface Drift {
  label: string
  role: Role
  expected: 'granted' | 'denied'
  actual: 'granted' | 'denied'
}

function parseCellState(text: string): 'granted' | 'denied' {
  // The doc uses "✓", "✓ (audited)", "✓ (own)", "✓ (assigned only, audited)" for
  // granted; "—" or "-" for denied. We collapse to a binary.
  const t = text.trim()
  if (t === '—' || t === '-' || t === '') return 'denied'
  if (t.startsWith('✓')) return 'granted'
  return 'denied'
}

function extractDocMatrix(md: string): Map<string, Map<Role, 'granted' | 'denied'>> {
  // Find the §20.1 matrix. We anchor on the header row.
  const lines = md.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (
      lines[i].startsWith('| Action ') &&
      lines[i].includes('super_admin') &&
      lines[i].includes('read_only')
    ) {
      start = i
      break
    }
  }
  if (start === -1) {
    throw new Error('Could not find permission matrix header in CLAUDE.md')
  }

  // Header row determines column order.
  const header = lines[start]
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
  // header[0] === "Action"; the rest are role names.
  const roleCols = header.slice(1) as Role[]
  for (const r of roleCols) {
    if (!ROLES.includes(r)) {
      throw new Error(`Unknown role in doc header: ${r}`)
    }
  }

  const rows = new Map<string, Map<Role, 'granted' | 'denied'>>()
  // Skip header + separator line.
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.startsWith('|')) break
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0)
    if (cells.length === 0) continue
    const label = cells[0].replace(/`/g, '')
    const states = new Map<Role, 'granted' | 'denied'>()
    for (let j = 0; j < roleCols.length; j += 1) {
      states.set(roleCols[j], parseCellState(cells[j + 1] ?? ''))
    }
    rows.set(label, states)
  }
  return rows
}

function main(): void {
  const md = readFileSync(CLAUDE_MD, 'utf8')
  const docRows = extractDocMatrix(md)

  const drift: Drift[] = []
  const missingFromDoc: string[] = []

  for (const [label, mapping] of Object.entries(DOC_LABEL_TO_ACTION)) {
    const action = (typeof mapping === 'string' ? mapping : mapping.action) as Action
    const docStates = docRows.get(label)
    if (!docStates) {
      missingFromDoc.push(label)
      continue
    }
    for (const role of ROLES) {
      const expected = cellFor(role, action)
      const actual = docStates.get(role) ?? 'denied'
      if (expected !== actual) {
        drift.push({ label, role, expected, actual })
      }
    }
  }

  // Also surface any ACTION in code but missing from the doc-mapping. New actions
  // need a row in §20.1 (or an explicit alias in DOC_LABEL_TO_ACTION).
  const mappedActions = new Set(
    Object.values(DOC_LABEL_TO_ACTION).map((m) => (typeof m === 'string' ? m : m.action)),
  )
  const actionsMissing: Action[] = []
  for (const a of ACTIONS) {
    if (!mappedActions.has(a)) {
      // user.deactivate is in policies but historically not in the doc table.
      // We tolerate it; flag it as a soft warning rather than a hard fail.
      actionsMissing.push(a)
    }
  }

  if (drift.length === 0 && missingFromDoc.length === 0) {
    console.log('Policy matrix in CLAUDE.md §20.1 matches packages/core/src/auth/policies.ts.')
    if (actionsMissing.length > 0) {
      console.log(
        `Note: ${actionsMissing.length} action(s) in code not represented in the doc table:`,
      )
      for (const a of actionsMissing) console.log(`  - ${a}`)
    }
    process.exit(0)
  }

  console.error('Policy matrix DRIFT detected.\n')
  if (missingFromDoc.length > 0) {
    console.error('Rows expected but missing from CLAUDE.md §20.1:')
    for (const l of missingFromDoc) console.error(`  - ${l}`)
    console.error('')
  }
  if (drift.length > 0) {
    console.error('Cell mismatches (code is the truth):')
    for (const d of drift) {
      console.error(
        `  ${d.label} / ${d.role}: doc="${d.actual}" code="${d.expected}"`,
      )
    }
  }
  // ATTRIBUTE_GATED_ACTIONS / AUDIT_REQUIRED_ACTIONS are referenced for future
  // checks but not currently asserted against the doc cell suffixes. Keep these
  // imports referenced so the lint / typecheck doesn't drop them.
  void ATTRIBUTE_GATED_ACTIONS
  void AUDIT_REQUIRED_ACTIONS
  process.exit(1)
}

main()
