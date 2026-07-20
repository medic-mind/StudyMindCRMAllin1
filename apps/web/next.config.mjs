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
  // Keep OpenTelemetry's SDK out of webpack's bundling pass. It pulls in
  // protobufjs which uses dynamic require() and triggers a "Critical
  // dependency" warning when bundled — leaving it as a server external
  // means Node loads it directly at runtime, no warning. This only
  // applies to server runtime (Node), not Edge.
  serverExternalPackages: [
    '@opentelemetry/sdk-node',
    '@opentelemetry/auto-instrumentations-node',
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/otlp-transformer',
    'protobufjs',
  ],
  // Server-only packages we don't want webpack to bundle. The OpenTelemetry
  // SDK declares optional peers we don't install (exporter-jaeger,
  // winston-transport) and pulls in protobufjs which uses dynamic require()
  // — both produce noisy warnings. Marking them as commonjs externals tells
  // webpack to leave the import as a runtime require() so Node loads them
  // directly. The OTel SDK only runs server-side; nothing client-bound
  // imports it. CLAUDE.md §25 (observability infrastructure).
  webpack: (config, { isServer }) => {
    const externals = [
      '@opentelemetry/exporter-jaeger',
      '@opentelemetry/winston-transport',
    ]
    // On the server we additionally externalise the OTel SDK + protobufjs
    // tree so the "Critical dependency" warning from protobufjs's dynamic
    // require disappears. We never run any of this in the browser.
    if (isServer) {
      externals.push(
        '@opentelemetry/sdk-node',
        '@opentelemetry/auto-instrumentations-node',
        '@opentelemetry/exporter-logs-otlp-grpc',
        '@opentelemetry/exporter-trace-otlp-grpc',
        '@opentelemetry/exporter-metrics-otlp-grpc',
        '@opentelemetry/otlp-transformer',
        'protobufjs',
        '@protobufjs/inquire',
      )
    }
    const externalMap = {}
    for (const e of externals) externalMap[e] = `commonjs ${e}`
    if (Array.isArray(config.externals)) {
      config.externals.push(externalMap)
    } else if (typeof config.externals === 'object' && config.externals) {
      Object.assign(config.externals, externalMap)
    } else {
      config.externals = externalMap
    }
    return config
  },
  async headers() {
    return [
      {
        // Everything EXCEPT the email render route, which sets its own headers
        // (relaxed CSP + X-Frame-Options SAMEORIGIN so /mail can frame it).
        // Applying X-Frame-Options: DENY here would block that frame.
        source: '/((?!api/internal/mail-render).*)',
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
