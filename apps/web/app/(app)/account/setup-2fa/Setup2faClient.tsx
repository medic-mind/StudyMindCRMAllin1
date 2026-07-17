'use client'

// Scoped NextAuth SessionProvider so the enrolment wizard can call
// `useSession().update()` after confirming — which re-issues the session
// cookie with the fresh `totpEnabledAt`, breaking the mandatory-MFA redirect
// loop (see flow.tsx). Scoped to this page only so the rest of the app keeps
// reading the JWT server-side with no client session fetch.

import { SessionProvider } from 'next-auth/react'

import { Setup2faFlow } from './flow'

export function Setup2faClient() {
  return (
    <SessionProvider>
      <Setup2faFlow />
    </SessionProvider>
  )
}
