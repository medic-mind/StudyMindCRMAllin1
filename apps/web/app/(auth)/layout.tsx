// (auth) segment shell — sign-in, verify, forgot, reset, accept-invite, and
// the NextAuth error page. A modern split: an abstract gradient hero on the
// left (brand mark only — no uploaded logo, no marketing copy), the form card
// on the right. The hero is hidden below lg so mobile gets a clean single
// column. ADR 0010, CLAUDE.md §4.

import { BrandLogo } from '@/components/shell/brand-logo'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-neutral-50">
      {/* Brand hero — abstract gradient, intentionally text-light. */}
      <aside
        className="relative hidden w-1/2 items-center justify-center overflow-hidden lg:flex"
        aria-hidden="true"
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(150deg, #4c1d95 0%, #7c3aed 46%, #a21caf 100%)',
          }}
        />
        {/* Soft depth glows */}
        <div className="absolute -left-24 -top-28 size-96 rounded-full bg-white/20 blur-3xl" />
        <div className="absolute -bottom-32 -right-20 size-[30rem] rounded-full bg-white/10 blur-3xl" />
        {/* Dotted grid motif */}
        <div
          className="absolute inset-0 opacity-[0.15]"
          style={{
            backgroundImage:
              'radial-gradient(circle, #ffffff 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />
        {/* Centre brand badge */}
        <div className="relative flex flex-col items-center gap-6 text-center text-white">
          <div className="flex size-28 items-center justify-center rounded-[1.75rem] bg-white/10 shadow-2xl shadow-black/20 ring-1 ring-white/25 backdrop-blur-md">
            <BrandLogo size={64} markOnly />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight">StudyMind</span>
            <span className="text-3xl font-light text-white/70">CRM</span>
          </div>
        </div>
      </aside>

      {/* Form column */}
      <div className="flex w-full flex-col items-center justify-center px-4 py-12 lg:w-1/2">
        <div className="mb-8 flex items-center gap-2 lg:hidden">
          <BrandLogo size={30} markOnly />
          <span className="text-lg font-semibold tracking-tight text-neutral-900">
            StudyMind <span className="font-light text-neutral-400">CRM</span>
          </span>
        </div>
        <main className="w-full max-w-md rounded-2xl border border-neutral-200/80 bg-white p-8 shadow-xl shadow-neutral-300/30">
          {children}
        </main>
        <p className="mt-6 text-center text-xs text-neutral-400">
          © {new Date().getFullYear()} StudyMind Ltd · Internal tool
        </p>
      </div>
    </div>
  )
}
