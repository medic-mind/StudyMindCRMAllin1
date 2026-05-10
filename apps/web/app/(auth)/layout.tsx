// (auth) segment shell — used by sign-in, sign-up, verify, forgot, reset, and
// the NextAuth error page. Centred card on a neutral background. ADR 0010.

import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12">
      <main className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-8 shadow-sm">
        <header className="mb-6 text-center">
          <Link href="/" className="text-sm font-semibold text-neutral-900">
            StudyMind CRM
          </Link>
        </header>
        {children}
      </main>
    </div>
  )
}
