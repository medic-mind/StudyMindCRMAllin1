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
      {/* Brand hero — one cohesive deep-blue gradient (on-brand with the
          primary scale), a soft top sheen for depth, intentionally text-light.
          No busy dotted grid; the calm surface reads more premium. */}
      <aside
        className="auth-hero-gradient relative hidden w-1/2 items-center justify-center overflow-hidden bg-[#172554] lg:flex"
        aria-hidden="true"
      >
        {/* Gradient + sheen live in globals.css classes (not inline `style`)
            so the strict CSP can't strip them and leave the hero white. */}
        <div className="auth-hero-gradient absolute inset-0" />
        {/* Subtle depth glows — kept low so the surface stays dark enough for
            crisp white text (no washed light-on-light patches). */}
        <div className="absolute -left-28 -top-32 size-[26rem] rounded-full bg-white/[0.08] blur-3xl" />
        <div className="absolute -bottom-36 -right-24 size-[32rem] rounded-full bg-white/[0.06] blur-3xl" />
        <div className="auth-hero-sheen absolute inset-0" />
        {/* Centre brand badge */}
        <div className="relative flex flex-col items-center gap-6 text-center text-white">
          <div className="flex size-28 items-center justify-center rounded-[1.75rem] bg-white/10 shadow-2xl shadow-black/20 ring-1 ring-white/25 backdrop-blur-md">
            <BrandLogo size={64} markOnly />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight">StudyMind</span>
            <span className="text-3xl font-light text-white/80">CRM</span>
          </div>
        </div>
      </aside>

      {/* Form column */}
      <div className="flex w-full flex-col items-center justify-center px-4 py-12 lg:w-1/2">
        <div className="mb-8 flex items-center gap-2 lg:hidden">
          <BrandLogo size={30} markOnly />
          <span className="text-lg font-semibold tracking-tight text-neutral-900">
            StudyMind <span className="font-light text-neutral-500">CRM</span>
          </span>
        </div>
        <main className="w-full max-w-md rounded-2xl border border-neutral-200/70 bg-white p-8 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_16px_40px_-16px_rgba(16,24,40,0.18)] sm:p-9">
          {children}
        </main>
        <p className="mt-6 text-center text-xs text-neutral-500">
          © {new Date().getFullYear()} StudyMind
        </p>
      </div>
    </div>
  )
}
