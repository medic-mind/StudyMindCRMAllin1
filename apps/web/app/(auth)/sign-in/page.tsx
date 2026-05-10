// Sign-in page. Email + password against the NextAuth Credentials provider.
// ADR 0010, CLAUDE.md §44.2.

import { SignInForm } from './form'

interface PageProps {
  searchParams: Promise<{
    callbackUrl?: string
    verified?: string
    error?: string
    message?: string
  }>
}

export default async function SignInPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const callbackUrl = sp.callbackUrl ?? '/inbox'
  const verified = sp.verified === '1'
  const setupComplete = sp.message === 'setup-complete'
  const initialError = sp.error ?? null

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">Sign in</h1>
      <p className="mb-6 text-sm text-neutral-600">Welcome back. Use your StudyMind credentials.</p>
      {verified && (
        <div
          className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
          role="status"
        >
          Email verified — you can sign in.
        </div>
      )}
      {setupComplete && (
        <div
          className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
          role="status"
        >
          Setup complete — sign in with the password you just set.
        </div>
      )}
      <SignInForm callbackUrl={callbackUrl} initialError={initialError} />
    </div>
  )
}
