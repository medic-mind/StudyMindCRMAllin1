import Link from 'next/link'

import { legacyAuth as auth } from '@/lib/auth/server'
import { GmailReconnectBanner } from '@/components/shell/gmail-reconnect-banner'
import { TrengoTokenBanner } from '@/components/shell/trengo-token-banner'

import { SignOutButton } from './sign-out-button'

// Authenticated CRM shell is always rendered per-request — never prerender.
// Without this, Next attempts to statically generate child pages at build
// time and the auth stub would throw `AUTH_PIVOT_PENDING` during static
// generation. Real auth gating returns in chunk 5 of ADR 0010.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NAV = [
  { href: '/inbox', label: 'Inbox' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/finance', label: 'Finance' },
  { href: '/reports', label: 'Reports' },
  { href: '/settings', label: 'Settings' },
] as const

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Stub: real session check returns in chunk 5 of ADR 0010.
  const { userId } = await auth()
  void userId

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col border-r border-neutral-200 bg-white p-4">
        <div className="mb-6 text-sm font-semibold text-neutral-900">StudyMind CRM</div>
        <nav className="flex flex-col gap-1 text-sm">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-1 border-t border-neutral-200 pt-4 text-sm">
          <Link
            href="/account"
            className="rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
          >
            Account
          </Link>
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1">
        <GmailReconnectBanner />
        <TrengoTokenBanner />
        <div className="p-6">{children}</div>
      </main>
    </div>
  )
}
