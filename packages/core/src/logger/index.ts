// Structured logging for the StudyMind CRM. See CLAUDE.md Section 25.
//
// Always log structured fields, never string concatenation:
//   logger.info({ familyId, action }, 'reconciled')
//
// Sensitive fields are redacted at the logger level so callers cannot
// accidentally leak PII or credentials, even if they pass a full payload.

import pino, { type Logger } from 'pino'

// Paths use pino's redaction syntax. The wildcard `*` matches one path
// segment, and `*.field` matches the field on any object in the tree at
// that depth. We add deep variants for the common nesting we see in
// webhooks and provider payloads.
const REDACT_PATHS = [
  // common PII on any first-level object
  '*.email',
  '*.phone',
  '*.dob',
  '*.refresh_token',
  '*.access_token',
  '*.dek',
  // request headers (case variants) — pino redaction is case-sensitive
  'headers.authorization',
  'headers.Authorization',
  'req.headers.authorization',
  'req.headers.Authorization',
  // top-level secrets occasionally logged from boundary code
  'authorization',
  'Authorization',
  'refresh_token',
  'access_token',
  'dek',
]

function resolveLevel(): pino.LevelWithSilent {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  const allowed: pino.LevelWithSilent[] = [
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'silent',
  ]
  return (allowed as string[]).includes(raw) ? (raw as pino.LevelWithSilent) : 'info'
}

export const logger: Logger = pino({
  level: resolveLevel(),
  // Force JSON output; never pretty-print in production paths.
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
    remove: false,
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
})

/**
 * Returns a child logger bound to the given OpenTelemetry request id.
 * Use at the entry of every webhook handler, tRPC procedure, and Inngest step.
 */
export function withRequest(requestId: string): Logger {
  return logger.child({ request_id: requestId })
}

/**
 * Returns a child logger bound to the calling actor. Pair with `withRequest`
 * inside protected procedures.
 */
export function withActor(actor: { id: string; role: string }): Logger {
  return logger.child({ actor_id: actor.id, actor_role: actor.role })
}

export type { Logger }
