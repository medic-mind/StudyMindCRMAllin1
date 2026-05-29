// Forward orchestrator tests. Self-contained in-memory fake DB mirroring the
// pattern in call-summary.test.ts.

import { describe, expect, it, vi } from 'vitest'

import { BusinessError } from '../errors'
import {
  buildTemplateContext,
  forwardEmail,
  renderRule,
  type ForwardingSender,
} from './forward'

interface Row {
  [k: string]: unknown
}

function makeDb() {
  const rules: Row[] = []
  const contacts: Row[] = []
  const interactions: Row[] = []
  const audits: Array<{ action: string; target?: unknown; after?: unknown }> = []

  const db = {
    forwardingRule: {
      findUnique: async ({ where }: { where: Row }) =>
        rules.find((r) => r.id === where.id || r.key === where.key) ?? null,
    },
    contact: {
      findFirst: async ({ where }: { where: Row }) => {
        const c = contacts.find((c) => c.id === where.id && c.deletedAt == null)
        if (!c) return null
        // Mirror the orchestrator's nested select: only return the
        // safeguarding flag(s) matching the where filter.
        const flags = Array.isArray(c.safeguardingFlags)
          ? (c.safeguardingFlags as Array<{ state: string }>).filter(
              (f) => f.state === 'restricted_access',
            )
          : []
        return { ...c, safeguardingFlags: flags }
      },
    },
    interaction: {
      create: async ({ data }: { data: Row }) => {
        interactions.push(data)
        return data
      },
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({
        data,
      }: {
        data: { id?: string; action: string; target?: unknown; after?: unknown }
      }) => {
        audits.push({ action: data.action, target: data.target, after: data.after })
        return { id: data.id ?? 'audit' }
      },
    },
  }

  return { db: db as never, rules, contacts, interactions, audits }
}

const ctx = { actorId: 'u1', requestId: 'req-fwd-1' }

function seed(t: ReturnType<typeof makeDb>) {
  t.rules.push({
    id: 'rule_ap',
    key: 'ap_team',
    label: 'Forward to AP Team',
    description: null,
    toAddresses: ['ap@studymind.co.uk'],
    ccAddresses: [],
    bccAddresses: [],
    subjectTemplate: 'Query: {{contactName}}',
    bodyTemplate: 'Hi,\n{{notes}}\n— {{agentName}}',
    sortOrder: 10,
    archivedAt: null,
  })
  t.contacts.push({
    id: 'c1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    phoneE164: '+447700900123',
    familyId: null,
    safeguardingFlags: [],
    deletedAt: null,
  })
}

describe('forwardEmail', () => {
  it('sends via the injected sender, records an Interaction, and audits', async () => {
    const t = makeDb()
    seed(t)
    const sender = vi.fn<ForwardingSender>(async () => ({
      status: 'sent',
      resendId: 'res_123',
    }))

    const result = await forwardEmail(
      t.db,
      {
        contactId: 'c1',
        ruleId: 'rule_ap',
        subject: 'Query: Jane Doe',
        body: 'Hi,\nplease take a look\n— Alex',
        sender,
      },
      ctx,
    )

    expect(result.status).toBe('sent')
    expect(result.resendId).toBe('res_123')
    expect(sender).toHaveBeenCalledTimes(1)
    expect(sender.mock.calls[0]?.[0]).toMatchObject({
      to: ['ap@studymind.co.uk'],
      cc: [],
      bcc: [],
      subject: 'Query: Jane Doe',
    })

    const created = t.interactions.find((i) => i.type === 'email_forwarded')
    expect(created).toBeDefined()
    expect((created!.payload as Row).ruleKey).toBe('ap_team')
    expect((created!.payload as Row).status).toBe('sent')
    expect((created!.payload as Row).to).toEqual(['ap@studymind.co.uk'])

    const audit = t.audits.find((a) => a.action === 'forwarding.email_sent')
    expect(audit).toBeDefined()
  })

  it('records a failed Interaction when the sender returns failed (no throw)', async () => {
    const t = makeDb()
    seed(t)
    const sender: ForwardingSender = async () => ({
      status: 'failed',
      resendId: null,
      detail: 'SMTP timeout',
    })

    const result = await forwardEmail(
      t.db,
      {
        contactId: 'c1',
        ruleId: 'rule_ap',
        subject: 'Query',
        body: 'body',
        sender,
      },
      ctx,
    )

    expect(result.status).toBe('failed')
    expect(result.detail).toBe('SMTP timeout')
    const created = t.interactions.find((i) => i.type === 'email_forwarded')
    expect((created!.payload as Row).status).toBe('failed')
    expect((created!.payload as Row).detail).toBe('SMTP timeout')
  })

  it('records a failed Interaction when the sender throws (no crash)', async () => {
    const t = makeDb()
    seed(t)
    const sender: ForwardingSender = async () => {
      throw new Error('network unreachable')
    }

    const result = await forwardEmail(
      t.db,
      {
        contactId: 'c1',
        ruleId: 'rule_ap',
        subject: 'Query',
        body: 'body',
        sender,
      },
      ctx,
    )

    expect(result.status).toBe('failed')
    expect(result.detail).toContain('network unreachable')
  })

  it('rejects sending against an archived rule', async () => {
    const t = makeDb()
    seed(t)
    t.rules[0]!.archivedAt = new Date()
    const sender: ForwardingSender = async () => ({ status: 'sent', resendId: 'x' })

    await expect(
      forwardEmail(
        t.db,
        {
          contactId: 'c1',
          ruleId: 'rule_ap',
          subject: 'Q',
          body: 'b',
          sender,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })

  it('rejects sending against a restricted contact', async () => {
    const t = makeDb()
    seed(t)
    t.contacts[0]!.safeguardingFlags = [{ state: 'restricted_access' }]
    const sender: ForwardingSender = async () => ({ status: 'sent', resendId: 'x' })

    await expect(
      forwardEmail(
        t.db,
        {
          contactId: 'c1',
          ruleId: 'rule_ap',
          subject: 'Q',
          body: 'b',
          sender,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'CONTACT_RESTRICTED' })
  })

  it('rejects sending against an unknown rule', async () => {
    const t = makeDb()
    seed(t)
    const sender: ForwardingSender = async () => ({ status: 'sent', resendId: 'x' })

    await expect(
      forwardEmail(
        t.db,
        {
          contactId: 'c1',
          ruleId: 'rule_nope',
          subject: 'Q',
          body: 'b',
          sender,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'FORWARDING_RULE_NOT_FOUND' })
  })
})

describe('renderRule + buildTemplateContext', () => {
  it('renders the rule using the contact + agent context', () => {
    const tctx = buildTemplateContext({
      appUrl: 'https://crm.studymind.co.uk/',
      contact: {
        id: 'c1',
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        phoneE164: '+447700900123',
      },
      family: { name: 'Doe Family' },
      agent: { name: 'Alex Agent', email: 'alex@studymind.co.uk' },
      notes: 'Please advise.',
    })

    const out = renderRule(
      {
        subjectTemplate: 'Query: {{contactName}}',
        bodyTemplate:
          '{{notes}} ({{contactEmail}}) — link: {{contactLink}} — by {{agentName}}',
      },
      tctx,
    )

    expect(out.subject).toBe('Query: Jane Doe')
    expect(out.body).toBe(
      'Please advise. (jane@example.com) — link: https://crm.studymind.co.uk/contacts/c1 — by Alex Agent',
    )
  })

  it('falls back to "this contact" when the name is empty', () => {
    const tctx = buildTemplateContext({
      appUrl: 'https://crm.studymind.co.uk',
      contact: {
        id: 'c2',
        firstName: null,
        lastName: null,
        email: null,
        phoneE164: null,
      },
      family: null,
      agent: { name: null, email: 'alex@studymind.co.uk' },
      notes: '',
    })
    expect(tctx.contactName).toBe('this contact')
    expect(tctx.agentName).toBe('alex@studymind.co.uk')
    expect(tctx.contactEmail).toBe('')
  })
})
