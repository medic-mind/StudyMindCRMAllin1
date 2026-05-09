import { withSentryConfig } from '@sentry/nextjs'

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
