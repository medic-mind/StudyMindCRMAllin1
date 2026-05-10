// Tests for the RBAC policy registry and grant policy. CLAUDE.md §20, ADR 0009.

import { describe, expect, it } from 'vitest'

import {
  ROLES,
  canGrantRole,
  canOverrideRestrictedDsl,
  canRevokeRole,
  roleCan,
  type Role,
} from './policies'

describe('roleCan', () => {
  it('super_admin has every action including admin-exclusive ones', () => {
    expect(roleCan('super_admin', 'user.role.grant_admin')).toBe(true)
    expect(roleCan('super_admin', 'user.role.grant_super_admin')).toBe(true)
    expect(roleCan('super_admin', 'user.role.revoke_admin')).toBe(true)
    expect(roleCan('super_admin', 'secrets.rotate')).toBe(true)
    expect(roleCan('super_admin', 'tenant.config.write')).toBe(true)
    expect(roleCan('super_admin', 'contact.read')).toBe(true)
  })

  it('admin can do daily admin work but not the super_admin-exclusive actions', () => {
    expect(roleCan('admin', 'user.invite')).toBe(true)
    expect(roleCan('admin', 'user.deactivate')).toBe(true)
    expect(roleCan('admin', 'settings.write')).toBe(true)
    expect(roleCan('admin', 'user.role.grant_admin')).toBe(false)
    expect(roleCan('admin', 'user.role.grant_super_admin')).toBe(false)
    expect(roleCan('admin', 'user.role.revoke_admin')).toBe(false)
    expect(roleCan('admin', 'secrets.rotate')).toBe(false)
    expect(roleCan('admin', 'tenant.config.write')).toBe(false)
  })

  it('agent cannot invite or deactivate users', () => {
    expect(roleCan('agent', 'user.invite')).toBe(false)
    expect(roleCan('agent', 'user.deactivate')).toBe(false)
    expect(roleCan('agent', 'settings.write')).toBe(false)
  })
})

describe('canGrantRole', () => {
  const lowerRoles: Role[] = ['ops_manager', 'agent', 'finance', 'dsl', 'read_only']

  it('super_admin can grant every role', () => {
    for (const r of ROLES) {
      expect(canGrantRole('super_admin', r)).toBe(true)
    }
  })

  it('admin can grant every role except admin and super_admin', () => {
    expect(canGrantRole('admin', 'admin')).toBe(false)
    expect(canGrantRole('admin', 'super_admin')).toBe(false)
    for (const r of lowerRoles) {
      expect(canGrantRole('admin', r)).toBe(true)
    }
  })

  it('non-admin roles cannot grant any role', () => {
    for (const actor of lowerRoles) {
      for (const target of ROLES) {
        expect(canGrantRole(actor, target)).toBe(false)
      }
    }
  })
})

describe('canRevokeRole', () => {
  const lowerRoles: Role[] = ['ops_manager', 'agent', 'finance', 'dsl', 'read_only']

  it('super_admin can revoke any role', () => {
    for (const r of ROLES) {
      expect(canRevokeRole('super_admin', r)).toBe(true)
    }
  })

  it('admin can revoke every role except admin and super_admin', () => {
    expect(canRevokeRole('admin', 'admin')).toBe(false)
    expect(canRevokeRole('admin', 'super_admin')).toBe(false)
    for (const r of lowerRoles) {
      expect(canRevokeRole('admin', r)).toBe(true)
    }
  })

  it('non-admin roles cannot revoke any role', () => {
    for (const actor of lowerRoles) {
      for (const target of ROLES) {
        expect(canRevokeRole(actor, target)).toBe(false)
      }
    }
  })
})

describe('canOverrideRestrictedDsl', () => {
  it('only super_admin and admin can override', () => {
    expect(canOverrideRestrictedDsl('super_admin')).toBe(true)
    expect(canOverrideRestrictedDsl('admin')).toBe(true)
    expect(canOverrideRestrictedDsl('dsl')).toBe(false)
    expect(canOverrideRestrictedDsl('ops_manager')).toBe(false)
    expect(canOverrideRestrictedDsl('agent')).toBe(false)
    expect(canOverrideRestrictedDsl('finance')).toBe(false)
    expect(canOverrideRestrictedDsl('read_only')).toBe(false)
  })
})
