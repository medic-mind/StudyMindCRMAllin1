// Structured logging for the StudyMind CRM. See CLAUDE.md Section 25.
//
// Always log structured fields, never string concatenation:
//   logger.info({ familyId, action }, 'reconciled')
//
// Sensitive fields are redacted at the logger level so callers cannot
// accidentally leak PII or credentials, even if they pass a full payload.
//
// Transport: in production we ship to Axiom via a small HTTP batcher (see
// axiom-transport.ts). Locally and in tests we keep stdout JSON for grep.

import pino, { type Logger } from 'pino'

import { createAxiomBatcher } from './axiom-transport'

const REDACT_PATHS = [
  '*.email',
  '*.phone',
  '*.dob',
  '*.refresh_token',
  '*.access_token',
  '*.dek',
  'headers.authorization',
  'headers.Authorization',
  'req.headers.authorization',
  'req.headers.Authorization',
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

const axiomToken = process.env['AXIOM_TOKEN']
const axiomDataset = process.env['AXIOM_DATASET']
const axiomEnabled =
  process.env.NODE_ENV === 'production' &&
  typeof axiomToken === 'string' &&
  axiomToken.length > 0 &&
  typeof axiomDataset === 'string' &&
  axiomDataset.length > 0

// When Axiom is enabled we tee log records to its HTTP ingest. We still
// emit JSON to stdout so Railway captures the same data for fallback.
const axiomBatcher = axiomEnabled
  ? createAxiomBatcher({ token: axiomToken as string, dataset: axiomDataset as string })
  : null

const stream = axiomBatcher
  ? {
      write(chunk: string): void {
        process.stdout.write(chunk)
        try {
          axiomBatcher.push(JSON.parse(chunk) as Record<string, unknown>)
        } catch {
          // Ignore malformed records; stdout has the truth either way.
        }
      },
    }
  : undefined

export const logger: Logger = pino(
  {
    level: resolveLevel(),
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
  },
  stream,
)

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

/** Force-flush any pending Axiom batch. Call from server shutdown hooks. */
export async function flushLogger(): Promise<void> {
  if (axiomBatcher) await axiomBatcher.flush()
}

export type { Logger }
