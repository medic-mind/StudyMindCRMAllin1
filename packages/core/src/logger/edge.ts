// Edge-runtime-safe logger. ADR 0010, CLAUDE.md §25.
//
// The full `@studymind/core/logger` exports a pino instance backed by
// process.stdout (and optionally an Axiom HTTP batcher). Pino cannot run
// in Next.js Edge Runtime because process.stdout, fs, and node:net are
// unavailable. Importing it from `apps/web/middleware.ts` causes the
// middleware module to throw at load time, which silently breaks every
// request — including /api/health — and Railway sees only "service
// unavailable" on the healthcheck.
//
// This file is a tiny console-backed JSON logger with the same shape
// as the Node logger (info/warn/error/debug, fields-first). It writes
// to stdout via console.log which Edge supports. No transports, no
// PII redaction at the logger layer — callers in Edge should not pass
// PII (middleware logs are access logs: method, path, status, request
// id, actor id only).
//
// Anything that needs structured shipping to Axiom or PII redaction must
// use the Node logger via `@studymind/core/logger` from a Node route.

type LogFields = Record<string, unknown>

function emit(level: 'debug' | 'info' | 'warn' | 'error', fields: LogFields | undefined, msg: string | undefined): void {
  const payload: LogFields = {
    level,
    time: new Date().toISOString(),
    ...(fields ?? {}),
  }
  if (msg !== undefined) payload['msg'] = msg
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload))
}

export interface EdgeLogger {
  debug(fields: LogFields, msg?: string): void
  info(fields: LogFields, msg?: string): void
  warn(fields: LogFields, msg?: string): void
  error(fields: LogFields, msg?: string): void
}

export const logger: EdgeLogger = {
  debug(fields, msg) {
    emit('debug', fields, msg)
  },
  info(fields, msg) {
    emit('info', fields, msg)
  },
  warn(fields, msg) {
    emit('warn', fields, msg)
  },
  error(fields, msg) {
    emit('error', fields, msg)
  },
}
