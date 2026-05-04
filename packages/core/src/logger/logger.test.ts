// Logger redaction tests. See CLAUDE.md Section 25.

import { Writable } from 'node:stream'

import pino from 'pino'
import { describe, expect, it } from 'vitest'

import { withActor, withRequest } from './index'

// Build a logger that mirrors src/logger/index.ts but writes into a buffer so
// the test can assert on the JSON output. The redact paths must stay in sync
// with the production logger; this is the contract under test.
function buildTestLogger(sink: Writable) {
  return pino(
    {
      level: 'info',
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: [
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
        ],
        censor: '[REDACTED]',
      },
      base: undefined,
    },
    sink,
  )
}

function captureLine(emit: (l: pino.Logger) => void): Record<string, unknown> {
  let captured = ''
  const sink = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString()
      cb()
    },
  })
  const log = buildTestLogger(sink)
  emit(log)
  // pino is synchronous when writing to a stream; the line is already on the buffer.
  return JSON.parse(captured.trim()) as Record<string, unknown>
}

describe('logger redaction', () => {
  it('redacts nested email and phone fields', () => {
    const line = captureLine((log) =>
      log.info({ contact: { email: 'a@b.com', phone: '+447700900123', name: 'Jane' } }, 'hi'),
    )
    const contact = line.contact as Record<string, unknown>
    expect(contact.email).toBe('[REDACTED]')
    expect(contact.phone).toBe('[REDACTED]')
    expect(contact.name).toBe('Jane')
  })

  it('redacts Authorization header', () => {
    const line = captureLine((log) =>
      log.info({ headers: { Authorization: 'Bearer secret' } }, 'req'),
    )
    const headers = line.headers as Record<string, unknown>
    expect(headers.Authorization).toBe('[REDACTED]')
  })

  it('redacts refresh and access tokens at top level', () => {
    const line = captureLine((log) =>
      log.info({ refresh_token: 'r', access_token: 'a', dek: 'd' }, 'tokens'),
    )
    expect(line.refresh_token).toBe('[REDACTED]')
    expect(line.access_token).toBe('[REDACTED]')
    expect(line.dek).toBe('[REDACTED]')
  })
})

describe('child loggers', () => {
  it('withRequest binds request_id', () => {
    const child = withRequest('req_123')
    expect(child.bindings().request_id).toBe('req_123')
  })

  it('withActor binds actor_id and actor_role', () => {
    const child = withActor({ id: 'user_1', role: 'admin' })
    const b = child.bindings()
    expect(b.actor_id).toBe('user_1')
    expect(b.actor_role).toBe('admin')
  })
})
