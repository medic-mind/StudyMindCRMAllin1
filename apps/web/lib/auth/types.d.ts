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
    }
  }

  interface User {
    id?: string
    mustResetPassword?: boolean
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string
    roles?: UserRole[]
    rolesLoadedAt?: number
    mustResetPassword?: boolean
  }
}
