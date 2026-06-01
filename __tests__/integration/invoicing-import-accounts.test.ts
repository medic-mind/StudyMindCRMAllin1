// Backfill → real CRM accounts. Verifies the three idempotency axes:
//   - re-running the import never creates duplicate accounts
//   - an already-linked mirror row updates (not re-creates)
//   - an unclassifiable customer lands in the Unsorted tray (needsClassification)
//   - b2b → account; alt_provision / b2c are not imported as accounts
//
// Uses a tiny in-memory Prisma-shaped fake + a fake invoicing client, so no
// Postgres / network. CLAUDE.md §2 (idempotency), §23 (integration tests).

import { describe, expect, it, vi } from 'vitest'

// Audit writer hits db.auditLogEntry; stub it so the fake db stays minimal.
vi.mock('@studymind/audit', () => ({ writeAuditLogEntry: vi.fn(async () => 'audit_1') }))

import { importAccounts } from '@studymind/integration-invoicing'

const { importBusinessAccountsFromInvoicing } = importAccounts

interface Row {
  id: string
  [k: string]: unknown
}

function matchesWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue
    // Prisma columns default to null; a created row that never set the column
    // reads as null in the DB, so treat an absent field as null here.
    const val = row[key] ?? null
    if (cond && typeof cond === 'object') {
      const c = cond as Record<string, unknown>
      const ci = c['mode'] === 'insensitive'
      if ('equals' in c) {
        const want = c['equals']
        if (ci && typeof want === 'string' && typeof val === 'string') {
          if (val.toLowerCase() !== want.toLowerCase()) return false
        } else if (val !== want) return false
      } else if ('startsWith' in c) {
        const pfx = String(c['startsWith'] ?? '')
        if (typeof val !== 'string') return false
        const hay = ci ? val.toLowerCase() : val
        const needle = ci ? pfx.toLowerCase() : pfx
        if (!hay.startsWith(needle)) return false
      } else if ('notIn' in c) {
        const list = (c['notIn'] as unknown[]) ?? []
        if (list.includes(val)) return false
      } else if (val !== cond) {
        return false
      }
    } else if (val !== cond) {
      return false
    }
  }
  return true
}

function makeTable() {
  const byId = new Map<string, Row>()
  return {
    byId,
    async findUnique({ where }: { where: Record<string, unknown>; select?: unknown }) {
      for (const row of byId.values()) {
        if (where['invoicingId'] !== undefined && row['invoicingId'] === where['invoicingId']) {
          return row
        }
        if (where['id'] !== undefined && row.id === where['id']) return row
      }
      return null
    },
    async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
      for (const row of byId.values()) {
        if (matchesWhere(row, where)) return row
      }
      return null
    },
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where?: Record<string, unknown>
      orderBy?: { createdAt?: 'asc' | 'desc' }
      take?: number
      select?: unknown
    } = {}) {
      let rows = [...byId.values()].filter((r) => matchesWhere(r, where))
      if (orderBy?.createdAt) {
        rows = rows.sort((a, b) => {
          const av = Number(a['createdAt'] ?? 0)
          const bv = Number(b['createdAt'] ?? 0)
          return orderBy.createdAt === 'asc' ? av - bv : bv - av
        })
      }
      return typeof take === 'number' ? rows.slice(0, take) : rows
    },
    async create({ data }: { data: Row }) {
      const row = { ...data }
      byId.set(row.id, row)
      return row
    },
    async upsert({
      where,
      create,
      update,
    }: {
      where: Record<string, unknown>
      create: Row
      update: Record<string, unknown>
    }) {
      for (const row of byId.values()) {
        if (where['invoicingId'] !== undefined && row['invoicingId'] === where['invoicingId']) {
          for (const [k, v] of Object.entries(update)) if (v !== undefined) row[k] = v
          return row
        }
      }
      const row = { ...create }
      byId.set(row.id, row)
      return row
    },
    async deleteMany() {
      return { count: 0 }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = byId.get(where.id)
      if (!row) throw new Error(`no row ${where.id}`)
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) row[k] = v
      }
      return row
    },
    async count({ where }: { where?: Record<string, unknown> } = {}) {
      let n = 0
      for (const row of byId.values()) if (matchesWhere(row, where)) n += 1
      return n
    },
  }
}

function makeDb() {
  return {
    businessAccount: makeTable(),
    invoicingCustomer: makeTable(),
    invoicingInvoice: makeTable(),
    invoicingLineItem: makeTable(),
    invoicingPayment: makeTable(),
    auditLogEntry: makeTable(),
  }
}

// A fake invoicing client returning fixed pages of customers (+ optional
// invoices, for the invoice-backfill pass).
function fakeClient(
  customers: Array<Record<string, unknown>>,
  invoices: Array<Record<string, unknown>> = [],
) {
  return {
    async listCustomers({ page = 1, page_size = 200 }: { page?: number; page_size?: number }) {
      const start = (page - 1) * page_size
      const data = customers.slice(start, start + page_size)
      return { data, page, page_size, total: customers.length }
    },
    async listInvoices({ page = 1, page_size = 200 }: { page?: number; page_size?: number }) {
      const start = (page - 1) * page_size
      const data = invoices.slice(start, start + page_size)
      return { data, page, page_size, total: invoices.length }
    },
  } as never
}

const ctx = { actorId: 'user_1', requestId: 'req_1' }

describe('importBusinessAccountsFromInvoicing', () => {
  it('creates real accounts for b2b, classifies, and skips b2c / alt_provision', async () => {
    const db = makeDb()
    const client = fakeClient([
      { id: 'p1', company_name: 'Oakwood Primary School', category: 'b2b' },
      { id: 'p2', company_name: 'Apex Tutoring Ltd', category: 'b2b' },
      { id: 'p3', company_name: 'Greenfield', category: 'b2b' }, // no signal → tray
      { id: 'p4', company_name: 'Jane Doe', category: 'b2c' }, // skipped
      { id: 'p5', company_name: 'County Council', category: 'alt_provision' }, // skipped
    ])

    const res = await importBusinessAccountsFromInvoicing(db as never, { ctx, client })

    expect(res.scanned).toBe(3) // only b2b
    expect(res.created).toBe(3)
    expect(db.businessAccount.byId.size).toBe(3)

    const accounts = [...db.businessAccount.byId.values()]
    const oakwood = accounts.find((a) => a['name'] === 'Oakwood Primary School')!
    expect(oakwood['kind']).toBe('school')
    expect(oakwood['needsClassification']).toBe(false)

    const apex = accounts.find((a) => a['name'] === 'Apex Tutoring Ltd')!
    expect(apex['kind']).toBe('partnership')

    const greenfield = accounts.find((a) => a['name'] === 'Greenfield')!
    expect(greenfield['needsClassification']).toBe(true)
    expect(res.needsClassification).toBe(1)
  })

  it('is idempotent — a second run creates no duplicates', async () => {
    const db = makeDb()
    const customers = [{ id: 'p1', company_name: 'Oakwood Primary School', category: 'b2b' }]

    const first = await importBusinessAccountsFromInvoicing(db as never, {
      ctx,
      client: fakeClient(customers),
    })
    const second = await importBusinessAccountsFromInvoicing(db as never, {
      ctx,
      client: fakeClient(customers),
    })

    expect(first.created).toBe(1)
    expect(second.created).toBe(0)
    expect(second.updated).toBe(1) // already-linked → update path
    expect(db.businessAccount.byId.size).toBe(1)
  })

  it('adopts an existing account by name + email instead of creating a duplicate', async () => {
    const db = makeDb()
    // Pre-seed a hand-made account with the same name + email, no mirror link.
    db.businessAccount.byId.set('acc_existing', {
      id: 'acc_existing',
      kind: 'school',
      name: 'Oakwood Primary School',
      contactEmail: 'office@oakwood.test',
      archivedAt: null,
    })

    const res = await importBusinessAccountsFromInvoicing(db as never, {
      ctx,
      client: fakeClient([
        {
          id: 'p1',
          company_name: 'Oakwood Primary School',
          category: 'b2b',
          contact_email: 'office@oakwood.test',
        },
      ]),
    })

    expect(res.created).toBe(0)
    expect(res.adopted).toBe(1)
    expect(db.businessAccount.byId.size).toBe(1) // no duplicate
    // The mirror row now links to the adopted account.
    const mirror = [...db.invoicingCustomer.byId.values()][0]
    expect(mirror!['businessAccountId']).toBe('acc_existing')
  })

  it('adopts despite whitespace/case differences in the name (no null-email dup)', async () => {
    const db = makeDb()
    // Pre-seed an account with a trailing space + different case, no email.
    db.businessAccount.byId.set('acc_existing', {
      id: 'acc_existing',
      kind: 'school',
      name: 'Oakwood  Primary  School ',
      contactEmail: null,
      archivedAt: null,
      createdAt: 1,
    })

    const res = await importBusinessAccountsFromInvoicing(db as never, {
      ctx,
      // Same school, clean name, no email — must adopt, not create a 2nd row.
      client: fakeClient([{ id: 'p1', company_name: 'oakwood primary school', category: 'b2b' }]),
    })

    expect(res.created).toBe(0)
    expect(res.adopted).toBe(1)
    expect(db.businessAccount.byId.size).toBe(1)
  })

  it('imports invoices in a second pass (idempotent, dedup on invoicingId)', async () => {
    const db = makeDb()
    const customers = [{ id: 'ptn_1', company_name: 'Oakwood Primary School', category: 'b2b' }]
    const invoices = [
      {
        id: 'inv_1',
        invoice_number: 'INV-1000',
        partner_id: 'ptn_1',
        status: 'issued',
        grand_total: '720.00',
        payments: [{ id: 'pay_1', amount: '200.00' }],
      },
      {
        id: 'inv_2',
        invoice_number: 'INV-1001',
        partner_id: 'ptn_1',
        status: 'paid',
        grand_total: '120.00',
      },
    ]

    const first = await importBusinessAccountsFromInvoicing(db as never, {
      ctx,
      client: fakeClient(customers, invoices),
    })
    expect(first.invoicesImported).toBe(2)
    expect(db.invoicingInvoice.byId.size).toBe(2)
    // Linked to the mirrored customer.
    const inv1 = [...db.invoicingInvoice.byId.values()].find((r) => r['invoicingId'] === 'inv_1')!
    expect(inv1['customerId']).toBeTruthy()

    // Re-run → no duplicate invoice rows.
    await importBusinessAccountsFromInvoicing(db as never, {
      ctx,
      client: fakeClient(customers, invoices),
    })
    expect(db.invoicingInvoice.byId.size).toBe(2)
  })
})
