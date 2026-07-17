// Sticky top app bar. 64px tall (matches `--shell-topbar-height` in
// globals.css). Plain-text "StudyMind CRM" wordmark at left (no logo mark),
// command-palette trigger in the centre, notifications bell + avatar menu at
// right. CLAUDE.md §4 (wordmark in primary blue, semibold), §26 (server
// component, client islands as leaves), §28 (skip-to-content link).

import Link from 'next/link'
import type { ReactNode } from 'react'

import { NotificationsBell } from './notifications-bell'
import { SearchTrigger } from './search-trigger'
import { UserMenu } from './user-menu'

interface Props {
  user: {
    email: string
    name: string | null
    role: string
    totpEnabled?: boolean
  }
  /** Custom-logo version (epoch millis) or null to use the inline SVG mark. */
  logoVersion?: number | null
  /** Far-left slot — the mobile nav hamburger (hidden on lg+). */
  leading?: ReactNode
}

export function TopBar({ user, leading }: Props) {
  return (
    <header
      role="banner"
      className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-neutral-200/70 bg-white/85 px-3 backdrop-blur sm:gap-4 sm:px-4"
      style={{ height: 'var(--shell-topbar-height)' }}
    >
      {/* Skip link — visible on focus only. CLAUDE.md §28. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-2 focus:py-1 focus:text-sm focus:text-primary-700"
      >
        Skip to content
      </a>

      {/* Mobile-only nav trigger (collapses to nothing on lg+). */}
      {leading}

      {/* Plain-text wordmark — no logo mark, per brand preference. Kept
          visible at every width; the name is short enough not to crowd the
          search field. "StudyMind" is one word (CLAUDE.md §4). */}
      <Link
        href="/"
        className="flex shrink-0 items-center gap-1.5 tracking-tight"
        aria-label="StudyMind CRM home"
      >
        <span className="text-base font-semibold text-primary-700">StudyMind</span>
        <span className="text-base font-medium text-neutral-500">CRM</span>
      </Link>

      <div className="flex flex-1 justify-center">
        <SearchTrigger />
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <NotificationsBell />
        <UserMenu
          email={user.email}
          name={user.name}
          role={user.role}
          totpEnabled={user.totpEnabled ?? false}
        />
      </div>
    </header>
  )
}
