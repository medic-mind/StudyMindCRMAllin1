// Tests for the studymind/registered-event-names ESLint rule.
// CLAUDE.md §45.1.

import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('./registered-event-names.js')

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

describe('studymind/registered-event-names', () => {
  it('accepts registered names and rejects unregistered names', () => {
    ruleTester.run('registered-event-names', rule, {
      valid: [
        // Registered audit action.
        `writeAuditLogEntry(db, { action: 'contact.created', actorId: 'u', target: { type: 't', id: '1' }, requestId: 'r' })`,
        // Registered Inngest event name.
        `inngest.send({ name: 'stripe/event.received', data: {} })`,
        // Registered Interaction.type.
        `db.interaction.create({ data: { type: 'note', payload: {} } })`,
        // Dynamic action — skipped (template literal with expression).
        `writeAuditLogEntry(db, { action: \`gocardless.\${kind}\` })`,
      ],
      invalid: [
        {
          code: `writeAuditLogEntry(db, { action: 'totally.fictional.action' })`,
          errors: [{ messageId: 'unregisteredAudit' }],
        },
        {
          code: `inngest.send({ name: 'made-up/event', data: {} })`,
          errors: [{ messageId: 'unregisteredInngest' }],
        },
        {
          code: `db.interaction.create({ data: { type: 'no_such_type', payload: {} } })`,
          errors: [{ messageId: 'unregisteredInteraction' }],
        },
      ],
    })
  })
})
