// (auth) segment shell — sign-in, sign-up, verify, forgot, reset, and the
// NextAuth error page. Split layout: a branded gradient panel (the product
// value prop) on the left, the form card on the right. The brand panel is
// hidden below lg so mobile gets a clean single column. ADR 0010, CLAUDE.md §4.

import Link from 'next/link'

import { BrandLogo } from '@/components/shell/brand-logo'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const HIGHLIGHTS = [
  'Every email, call, message and payment for a customer in one place',
  'Boards you control — your stages, your labels, your subjects',
  'Direct Debit and reconciliation visibility across Stripe and GoCardless',
] as const

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-neutral-50">
      {/* Brand hero — hidden on small screens */}
      <aside
        className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-primary-700 p-12 text-white lg:flex"
        aria-hidden="true"
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 120% at 0% 0%, #6d28d9 0%, transparent 55%), linear-gradient(135deg, #581c87 0%, #9333ea 55%, #a21caf 100%)',
          }}
        />
        <div className="relative flex items-center gap-2">
          <BrandLogo size={32} markOnly />
          <span className="text-lg font-semibold tracking-tight">StudyMind CRM</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            One pane of glass for every customer relationship.
          </h2>
          <ul className="mt-8 space-y-4">
            {HIGHLIGHTS.map((h) => (
              <li key={h} className="flex items-start gap-3 text-sm text-primary-50">
                <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-white/80" />
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-primary-100/80">
          Internal tool · StudyMind Ltd
        </p>
      </aside>

      {/* Form column */}
      <div className="flex w-full flex-col items-center justify-center px-4 py-12 lg:w-1/2">
        <main className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-lg shadow-neutral-200/60">
          <header className="mb-6 lg:hidden">
            <Link href="/" className="text-sm font-semibold text-neutral-900">
              StudyMind CRM
            </Link>
          </header>
          {children}
        </main>
        <p className="mt-6 text-center text-xs text-neutral-400">
          © {new Date().getFullYear()} StudyMind Ltd
        </p>
      </div>
    </div>
  )
}
