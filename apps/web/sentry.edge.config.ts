// Sentry edge-runtime init (middleware, edge routes). CLAUDE.md §25.

import * as Sentry from '@sentry/nextjs'

import { registerSentry } from '@studymind/core/observability/sentry'

const env = process.env['SENTRY_ENVIRONMENT'] ?? process.env['NODE_ENV'] ?? 'development'

const tracesSampleRate = env === 'production' ? 0.1 : env === 'staging' ? 1.0 : 0

Sentry.init({
  dsn: process.env['SENTRY_DSN'] ?? '',
  environment: env,
  release: process.env['RAILWAY_GIT_COMMIT_SHA'] ?? process.env['SENTRY_RELEASE'],
  tracesSampleRate,
  enabled: env !== 'development' && env !== 'test',
})

registerSentry({
  captureException: (e, hint) => {
    Sentry.captureException(e, hint ? { tags: hint.tags } : undefined)
  },
})
