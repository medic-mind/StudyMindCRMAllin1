import { withSentryConfig } from '@sentry/nextjs'

// Static security headers. CSP is set per-request in middleware so we can
// inject a nonce; the rest are stable enough to live here.
// CLAUDE.md §44.2.
const STATIC_SECURITY_HEADERS = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@studymind/audit',
    '@studymind/core',
    '@studymind/db',
    '@studymind/integration-aircall',
    '@studymind/integration-asana',
    '@studymind/integration-booking',
    '@studymind/integration-gmail',
    '@studymind/integration-gocardless',
    '@studymind/integration-slack',
    '@studymind/integration-stripe',
    '@studymind/integration-trengo',
    '@studymind/jobs',
    '@studymind/ui',
  ],
  experimental: {
    typedRoutes: false,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: STATIC_SECURITY_HEADERS,
      },
    ]
  },
}

// withSentryConfig uploads source maps when SENTRY_AUTH_TOKEN is set (CI / Railway).
// Locally the token is absent, so this is a no-op pass-through.
const sentryWebpackPluginOptions = {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  disableServerWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  disableClientWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
}

export default withSentryConfig(nextConfig, sentryWebpackPluginOptions)
