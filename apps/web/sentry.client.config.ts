// Sentry browser-side init. CLAUDE.md §25.
// Loaded by Next.js automatically via instrumentation. Tracesample is
// environment-driven so prod stays cheap and staging stays informative.

import * as Sentry from '@sentry/nextjs'

const env = process.env['SENTRY_ENVIRONMENT'] ?? process.env['NODE_ENV'] ?? 'development'

const tracesSampleRate = env === 'production' ? 0.1 : env === 'staging' ? 1.0 : 0

Sentry.init({
  dsn: process.env['NEXT_PUBLIC_SENTRY_DSN'] ?? process.env['SENTRY_DSN'] ?? '',
  environment: env,
  release: process.env['RAILWAY_GIT_COMMIT_SHA'] ?? process.env['SENTRY_RELEASE'],
  tracesSampleRate,
  enabled: env !== 'development' && env !== 'test',
})
