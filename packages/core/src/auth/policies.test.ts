// Tests for the RBAC policy registry and grant policy. CLAUDE.md §20, ADR 0014.

import { describe, expect, it } from 'vitest'

import {
  ACTIONS,
  ROLES,
  canGrantRole,
  canRevokeRole,
  normaliseRole,
  pickPrimaryRole,
  roleCan,
  type Role,
} from './policies'

describe('roleCan', () => {
  it('ceo has every action including ceo-tier grants', () => {
    for (const a of ACTIONS) {
      expect(roleCan('ceo', a)).toBe(true)
    }
  })

  it('senior_manager covers operational + finance + user mgmt, never ceo-tier grants', () => {
    expect(roleCan('senior_manager', 'contact.write')).toBe(true)
    expect(roleCan('senior_manager', 'charge.refund')).toBe(true)
    expect(roleCan('senior_manager', 'subscription.cancel')).toBe(true)
    expect(roleCan('senior_manager', 'dsar.export')).toBe(true)
    expect(roleCan('senior_manager', 'settings.write')).toBe(true)
    expect(roleCan('senior_manager', 'user.invite')).toBe(true)
    expect(roleCan('senior_manager', 'user.deactivate')).toBe(true)
    expect(roleCan('senior_manager', 'user.role.revoke_senior_manager')).toBe(true)
    expect(roleCan('senior_manager', 'user.role.grant_senior_manager')).toBe(false)
    expect(roleCan('senior_manager', 'user.role.grant_ceo')).toBe(false)
    expect(roleCan('senior_manager', 'secrets.rotate')).toBe(false)
    expect(roleCan('senior_manager', 'tenant.config.write')).toBe(false)
  })

  it('manager runs sales + finance ops; no deactivation, no settings write', () => {
    expect(roleCan('manager', 'contact.write')).toBe(true)
    expect(roleCan('manager', 'family.merge')).toBe(true)
    expect(roleCan('manager', 'charge.create_link')).toBe(true)
    expect(roleCan('manager', 'charge.refund')).toBe(true)
    expect(roleCan('manager', 'subscription.cancel')).toBe(true)
    expect(roleCan('manager', 'user.invite')).toBe(true)
    expect(roleCan('manager', 'user.deactivate')).toBe(false)
    expect(roleCan('manager', 'settings.write')).toBe(false)
    expect(roleCan('manager', 'dsar.export')).toBe(false)
    expect(roleCan('manager', 'interaction.delete')).toBe(false)
  })

  it('sales_executive has full Contact CRUD + payment links, never refunds', () => {
    expect(roleCan('sales_executive', 'contact.write')).toBe(true)
    expect(roleCan('sales_executive', 'interaction.create')).toBe(true)
    expect(roleCan('sales_executive', 'charge.create_link')).toBe(true)
    expect(roleCan('sales_executive', 'charge.refund')).toBe(false)
    expect(roleCan('sales_executive', 'family.merge')).toBe(false)
    expect(roleCan('sales_executive', 'user.invite')).toBe(false)
    expect(roleCan('sales_executive', 'subscription.cancel')).toBe(false)
  })

  it('virtual_assistant can read + draft, no writes that move money or send messages', () => {
    expect(roleCan('virtual_assistant', 'contact.read')).toBe(true)
    expect(roleCan('virtual_assistant', 'interaction.create')).toBe(true)
    expect(roleCan('virtual_assistant', 'contact.write')).toBe(false)
    expect(roleCan('virtual_assistant', 'charge.create_link')).toBe(false)
    expect(roleCan('virtual_assistant', 'charge.refund')).toBe(false)
  })
})

describe('canGrantRole', () => {
  it('ceo can grant every role', () => {
    for (const r of ROLES) {
      expect(canGrantRole('ceo', r)).toBe(true)
    }
  })

  it('senior_manager can grant manager, sales_executive, virtual_assistant only', () => {
    expect(canGrantRole('senior_manager', 'ceo')).toBe(false)
    expect(canGrantRole('senior_manager', 'senior_manager')).toBe(false)
    expect(canGrantRole('senior_manager', 'manager')).toBe(true)
    expect(canGrantRole('senior_manager', 'sales_executive')).toBe(true)
    expect(canGrantRole('senior_manager', 'virtual_assistant')).toBe(true)
  })

  it('manager / sales_executive / virtual_assistant cannot grant any role', () => {
    const lower: Role[] = ['manager', 'sales_executive', 'virtual_assistant']
    for (const actor of lower) {
      for (const target of ROLES) {
        expect(canGrantRole(actor, target)).toBe(false)
      }
    }
  })
})

describe('canRevokeRole', () => {
  it('matrix is symmetric with canGrantRole', () => {
    for (const actor of ROLES) {
      for (const target of ROLES) {
        expect(canRevokeRole(actor, target)).toBe(canGrantRole(actor, target))
      }
    }
  })
})

describe('normaliseRole', () => {
  it('returns canonical roles unchanged', () => {
    for (const r of ROLES) {
      expect(normaliseRole(r)).toBe(r)
    }
  })

  it('maps legacy roles to their canonical successor', () => {
    expect(normaliseRole('super_admin')).toBe('ceo')
    expect(normaliseRole('admin')).toBe('senior_manager')
    expect(normaliseRole('ops_manager')).toBe('manager')
    expect(normaliseRole('finance')).toBe('manager')
    expect(normaliseRole('dsl')).toBe('manager')
    expect(normaliseRole('agent')).toBe('sales_executive')
    expect(normaliseRole('read_only')).toBe('virtual_assistant')
  })

  it('returns null for unknown values', () => {
    expect(normaliseRole('intern')).toBe(null)
    expect(normaliseRole('')).toBe(null)
  })
})

describe('pickPrimaryRole', () => {
  it('returns the highest-priority canonical role from a mixed list', () => {
    expect(pickPrimaryRole(['sales_executive', 'manager'])).toBe('manager')
    expect(pickPrimaryRole(['virtual_assistant', 'senior_manager'])).toBe('senior_manager')
    expect(pickPrimaryRole(['ceo'])).toBe('ceo')
  })

  it('normalises legacy values', () => {
    expect(pickPrimaryRole(['agent', 'admin'])).toBe('senior_manager')
    expect(pickPrimaryRole(['read_only', 'finance'])).toBe('manager')
    expect(pickPrimaryRole(['super_admin', 'admin'])).toBe('ceo')
    expect(pickPrimaryRole(['dsl'])).toBe('manager')
  })

  it('defaults to virtual_assistant on empty / unknown input', () => {
    expect(pickPrimaryRole([])).toBe('virtual_assistant')
    expect(pickPrimaryRole(['intern'])).toBe('virtual_assistant')
  })
})
