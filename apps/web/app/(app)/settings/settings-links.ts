// Single source of truth for the Settings pages. Consumed by BOTH the Settings
// landing (settings/page.tsx) and the sidebar Settings sub-nav (layout.tsx
// buildNav → settingsNavChildren). Keeping ONE list prevents the two from
// drifting — that drift previously left the sidebar showing only a handful of
// the settings pages. Add a new settings page HERE and both surfaces update.
//
// Deliberately excluded (2026-07 declutter): Email accounts + Invoicing live
// under Integrations (the single external-services hub); My mailboxes lives in
// the user menu (top-right); Feature flags is a URL-only dev tool.

export type SettingsIconKey =
  | 'users'
  | 'shield'
  | 'companies'
  | 'branding'
  | 'mail'
  | 'coins'
  | 'git'
  | 'building'
  | 'integrations'

export interface SettingsLink {
  href: string
  /** Landing-tile title. */
  title: string
  /** Shorter label for the sidebar sub-nav (defaults to `title`). */
  navLabel?: string
  description: string
  roles: string
  icon: SettingsIconKey
}

export interface SettingsGroup {
  title: string
  description?: string
  links: SettingsLink[]
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: 'People & Access',
    description: 'Who can use the CRM and what they can do.',
    links: [
      {
        href: '/settings/users',
        title: 'Users',
        navLabel: 'Users',
        description:
          'Create accounts, reset or reissue logins, delete/erase, per-user permissions, avatars. Audited.',
        roles: 'CEO · SM · Manager',
        icon: 'users',
      },
      {
        href: '/settings/teams',
        title: 'Teams',
        description: 'Group ops staff into squads (shared inbox teams + assignment pickers).',
        roles: 'CEO · Senior Manager',
        icon: 'users',
      },
      {
        href: '/settings/roles',
        title: 'Roles & permissions',
        navLabel: 'Roles',
        description: 'Create custom roles and assign permissions on top of the built-in roles.',
        roles: 'CEO · Senior Manager',
        icon: 'shield',
      },
    ],
  },
  {
    title: 'Brand & Data',
    description: 'Tags, brand identity, and what families see.',
    links: [
      {
        href: '/settings/companies',
        title: 'Companies',
        description: 'Sister-brand tags (Medic Mind, Oxbridge Mind, StudyMind, anything you add).',
        roles: 'CEO · Senior Manager',
        icon: 'companies',
      },
      {
        href: '/settings/branding',
        title: 'Branding',
        description: 'Upload the logo shown in the top bar and on sign-in.',
        roles: 'CEO · Senior Manager',
        icon: 'branding',
      },
    ],
  },
  {
    title: 'Workflows',
    description: 'Quick actions the agents trigger from a contact.',
    links: [
      {
        href: '/settings/forwarding',
        title: 'Forwarding rules',
        navLabel: 'Forwarding',
        description:
          'Configure the “Forward to <team>” quick actions (AP team, CEOs, schools, partnerships).',
        roles: 'Manager+',
        icon: 'mail',
      },
      {
        href: '/settings/dd-recovery-templates',
        title: 'Direct Debit recovery',
        navLabel: 'DD recovery',
        description:
          'The escalating email + text sequence for chasing an unpaid Direct Debit, plus the late fee, cadence and letterhead. Court fee + interest are calculated automatically.',
        roles: 'Manager+',
        icon: 'coins',
      },
      {
        href: '/settings/slack-channels',
        title: 'Slack channels',
        description:
          'The Slack channels the CRM posts to (call-summary action points with deep-link buttons), and where each kind of notification is routed.',
        roles: 'Manager+',
        icon: 'git',
      },
      {
        href: '/settings/quick-replies',
        title: 'Quick replies',
        description:
          'Canned responses agents insert into a conversation reply. Personalise with {{first_name}} / {{name}}.',
        roles: 'Manager+',
        icon: 'mail',
      },
      {
        href: '/settings/account-labels',
        title: 'Labels',
        description:
          'Custom, colour-coded labels for customers and B2B accounts. Apply them in bulk from the Customers or Accounts lists.',
        roles: 'Manager+',
        icon: 'building',
      },
      {
        href: '/settings/board-quick-actions',
        title: 'Board quick actions',
        navLabel: 'Board actions',
        description:
          'Configure the per-card buttons on each board (Called once, Called twice, Invalid number…). Pick a board to manage its buttons.',
        roles: 'Manager+',
        icon: 'git',
      },
    ],
  },
  {
    title: 'Platform',
    description: 'External services and system connections.',
    links: [
      {
        href: '/settings/integrations',
        title: 'Integrations',
        description:
          'The hub for every external service — webhook status, plus B2B invoicing, email accounts and Slack routing.',
        roles: 'CEO · Senior Manager · Manager',
        icon: 'integrations',
      },
    ],
  },
]

/** Flat `{ href, label }` list for the sidebar Settings sub-nav. */
export function settingsNavChildren(): Array<{ href: string; label: string }> {
  return SETTINGS_GROUPS.flatMap((g) => g.links.map((l) => ({ href: l.href, label: l.navLabel ?? l.title })))
}
