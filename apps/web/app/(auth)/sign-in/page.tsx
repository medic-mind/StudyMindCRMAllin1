// Sign-in page. Email + password against the NextAuth Credentials provider.
// ADR 0010, CLAUDE.md §44.2.

import { SignInForm } from './form'

interface PageProps {
  searchParams: Promise<{
    callbackUrl?: string
    verified?: string
    error?: string
  }>
}

export default async function SignInPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const callbackUrl = sp.callbackUrl ?? '/inbox'
  const verified = sp.verified === '1'
  const initialError = sp.error ?? null

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[1.7rem] font-semibold tracking-tight text-neutral-900">
          Welcome back
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Sign in to the StudyMind CRM.
        </p>
      </div>
      {verified && (
        <div
          className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
          role="status"
        >
          Email verified — you can sign in.
        </div>
      )}
      <SignInForm callbackUrl={callbackUrl} initialError={initialError} />
    </div>
  )
}
