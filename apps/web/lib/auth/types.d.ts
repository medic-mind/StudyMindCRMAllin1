// Session/User/JWT augmentation for NextAuth v5 (ADR 0010).

import 'next-auth'
import 'next-auth/jwt'

import type { UserRole } from '@/lib/trpc/builders'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      email: string
      name?: string | null
      role: UserRole
      roles: UserRole[]
      mustResetPassword: boolean
      /** ISO string when MFA was last enabled, or null. CLAUDE.md §20. */
      totpEnabledAt: string | null
      /** The Session row id this cookie maps to. Used by the sessions UI. */
      sessionId?: string
    }
  }

  interface User {
    id?: string
    mustResetPassword?: boolean
    sessionId?: string
    totpEnabledAt?: string | null
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string
    sid?: string
    roles?: UserRole[]
    rolesLoadedAt?: number
    mustResetPassword?: boolean
    totpEnabledAt?: string | null
  }
}
