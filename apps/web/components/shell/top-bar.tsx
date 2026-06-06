// Sticky top app bar. 64px tall (matches `--shell-topbar-height` in
// globals.css). Logo at left, command-palette trigger in the centre,
// notifications bell + avatar menu at right. CLAUDE.md §4 (wordmark in
// primary blue, semibold), §26 (server component, client islands as
// leaves), §28 (skip-to-content link).

import Link from 'next/link'

import { BrandLogo } from './brand-logo'
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
}

export function TopBar({ user }: Props) {
  return (
    <header
      role="banner"
      className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-neutral-200/70 bg-white/85 px-4 backdrop-blur"
      style={{ height: 'var(--shell-topbar-height)' }}
    >
      {/* Skip link — visible on focus only. CLAUDE.md §28. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-2 focus:py-1 focus:text-sm focus:text-primary-700"
      >
        Skip to content
      </a>

      {/* Fixed inline SVG mark + wordmark only. We deliberately do NOT render
          the uploaded custom logo here — a wide/tall upload kept enlarging and
          blowing out the bar, so the top bar always uses the crisp, fixed-size
          brand mark. The uploaded logo still lives on Settings → Branding. */}
      <Link
        href="/"
        className="flex shrink-0 items-center gap-2 tracking-tight"
        aria-label="StudyMind CRM home"
      >
        <BrandLogo size={26} markOnly />
        <span className="text-base font-semibold text-primary-700">StudyMind</span>
        <span className="text-base font-medium text-neutral-500">CRM</span>
      </Link>

      <div className="flex flex-1 justify-center">
        <SearchTrigger />
      </div>

      <div className="flex items-center gap-2">
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
