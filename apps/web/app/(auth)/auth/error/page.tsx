// NextAuth error page. Maps known error codes to friendly copy. ADR 0010.

import Link from 'next/link'

interface PageProps {
  searchParams: Promise<{ error?: string }>
}

const COPY: Record<string, { title: string; body: string }> = {
  Configuration: {
    title: 'Sign-in is unavailable',
    body: 'There is a server configuration issue. Please contact support.',
  },
  AccessDenied: {
    title: 'Access denied',
    body: 'You do not have permission to sign in. Contact your admin.',
  },
  Verification: {
    title: 'Verification link expired',
    body: 'The verification link has expired or has already been used.',
  },
  CredentialsSignin: {
    title: 'Invalid email or password',
    body: 'The email or password you entered did not match our records.',
  },
}

export default async function AuthErrorPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const code = sp.error ?? 'Default'
  const copy = COPY[code] ?? {
    title: 'Sign-in failed',
    body: 'Something went wrong. Please try again.',
  }
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">{copy.title}</h1>
      <p className="mb-6 text-sm text-neutral-600">{copy.body}</p>
      <p className="text-center text-xs text-neutral-600">
        <Link href="/sign-in" className="font-medium text-neutral-900 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
