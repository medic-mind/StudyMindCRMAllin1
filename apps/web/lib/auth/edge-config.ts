// Edge-runtime-safe NextAuth config. Imported by middleware.ts.
//
// The full config in lib/auth/index.ts pulls in Prisma + bcrypt + node:crypto
// pieces that the Edge runtime cannot execute. This file provides only what
// the JWT decoder needs to read the cookie and populate `req.auth`.
//
// ADR 0010, https://authjs.dev/guides/edge-compatibility

import type { NextAuthConfig } from 'next-auth'

const isProd = process.env.NODE_ENV === 'production'
const sessionCookieName = isProd ? '__Secure-studymind.session' : 'studymind.session'

export const authEdgeConfig: NextAuthConfig = {
  session: {
    strategy: 'jwt',
    maxAge: 12 * 60 * 60,
  },
  cookies: {
    sessionToken: {
      name: sessionCookieName,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: isProd,
      },
    },
  },
  secret: process.env.AUTH_SECRET,
  // No providers in edge — sign-in goes through the node-runtime route.
  providers: [],
  pages: {
    signIn: '/sign-in',
    verifyRequest: '/verify-email-sent',
    error: '/auth/error',
  },
  callbacks: {
    // Mirror the node-side session callback so middleware sees mustResetPassword
    // and can force-redirect to /account/change-password. We do not call out
    // to the database from the edge — every value here comes from the JWT.
    session({ session, token }) {
      if (token && session.user) {
        if (typeof token.uid === 'string') session.user.id = token.uid
        session.user.mustResetPassword = Boolean(token.mustResetPassword)
      }
      return session
    },
  },
}
