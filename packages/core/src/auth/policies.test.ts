// Tests for the RBAC policy registry and grant policy. CLAUDE.md §20, ADR 0014.

import { describe, expect, it } from 'vitest'

import {
  ACTIONS,
  ASSIGNABLE_ACTIONS,
  DENY_LIST_ACTIONS,
  ROLES,
  canCreateUsers,
  canCreateUserAtRole,
  canDeactivateUsers,
  canGrantRole,
  canGrantUserManage,
  canManageUsers,
  canRevokeRole,
  hasAction,
  isAssignableAction,
  isGrantableAction,
  normaliseRole,
  pickPrimaryRole,
  roleCan,
  sanitizeRolePermissions,
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

  it('manager runs sales + finance ops; manages users but cannot create or deactivate them', () => {
    expect(roleCan('manager', 'contact.write')).toBe(true)
    expect(roleCan('manager', 'family.merge')).toBe(true)
    expect(roleCan('manager', 'charge.create_link')).toBe(true)
    expect(roleCan('manager', 'charge.refund')).toBe(true)
    expect(roleCan('manager', 'subscription.cancel')).toBe(true)
    // ADR 0021: managers can edit details + reset passwords and delegate that
    // right, but cannot create accounts or deactivate users.
    expect(roleCan('manager', 'user.manage')).toBe(true)
    expect(roleCan('manager', 'user.grant_manage')).toBe(true)
    expect(roleCan('manager', 'user.invite')).toBe(false)
    expect(roleCan('manager', 'user.deactivate')).toBe(false)
    // 2026-07: operational settings are now open to every staff role.
    expect(roleCan('manager', 'settings.write')).toBe(true)
    expect(roleCan('manager', 'dsar.export')).toBe(false)
    expect(roleCan('manager', 'interaction.delete')).toBe(false)
  })

  it('sales_executive can do everything operational except the locked buckets (2026-07)', () => {
    expect(roleCan('sales_executive', 'contact.read')).toBe(true)
    expect(roleCan('sales_executive', 'contact.read_minor')).toBe(true)
    expect(roleCan('sales_executive', 'contact.write')).toBe(true)
    expect(roleCan('sales_executive', 'interaction.create')).toBe(true)
    expect(roleCan('sales_executive', 'charge.create_link')).toBe(true)
    expect(roleCan('sales_executive', 'charge.refund')).toBe(true)
    expect(roleCan('sales_executive', 'subscription.cancel')).toBe(true)
    expect(roleCan('sales_executive', 'user.invite')).toBe(true)
    // Widened 2026-07 — "VA and above can do anything operational":
    expect(roleCan('sales_executive', 'family.merge')).toBe(true)
    expect(roleCan('sales_executive', 'settings.write')).toBe(true)
    // The locked buckets (users / integrations / audit / DSAR / destructive)
    // stay denied at the role level.
    expect(roleCan('sales_executive', 'interaction.delete')).toBe(false)
    expect(roleCan('sales_executive', 'audit.read')).toBe(false)
    expect(roleCan('sales_executive', 'user.manage')).toBe(false)
    expect(roleCan('sales_executive', 'dsar.export')).toBe(false)
    expect(roleCan('sales_executive', 'secrets.rotate')).toBe(false)
    expect(roleCan('sales_executive', 'tenant.config.write')).toBe(false)
  })

  it('virtual_assistant has an IDENTICAL capability set to sales_executive (2026-07)', () => {
    for (const a of ACTIONS) {
      expect(roleCan('virtual_assistant', a)).toBe(roleCan('sales_executive', a))
    }
    // Spot-check the newly-shared powers.
    expect(roleCan('virtual_assistant', 'contact.write')).toBe(true)
    expect(roleCan('virtual_assistant', 'charge.refund')).toBe(true)
    expect(roleCan('virtual_assistant', 'subscription.cancel')).toBe(true)
    expect(roleCan('virtual_assistant', 'user.invite')).toBe(true)
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

describe('user-management capabilities (ADR 0021)', () => {
  it('CEO, Senior Manager, Sales Executive and Virtual Assistant can create accounts; Manager cannot', () => {
    expect(canCreateUsers('ceo')).toBe(true)
    expect(canCreateUsers('senior_manager')).toBe(true)
    expect(canCreateUsers('manager')).toBe(false)
    expect(canCreateUsers('sales_executive')).toBe(true)
    expect(canCreateUsers('virtual_assistant')).toBe(true)
  })

  it('account creation cannot be a privilege-escalation path (canCreateUserAtRole)', () => {
    // CEO / Senior Manager keep the canGrantRole reach.
    expect(canCreateUserAtRole('ceo', 'ceo')).toBe(true)
    expect(canCreateUserAtRole('senior_manager', 'manager')).toBe(true)
    // Sales Executive + Virtual Assistant may create ONLY at their own tier.
    for (const actor of ['sales_executive', 'virtual_assistant'] as Role[]) {
      expect(canCreateUserAtRole(actor, 'sales_executive')).toBe(true)
      expect(canCreateUserAtRole(actor, 'virtual_assistant')).toBe(true)
      expect(canCreateUserAtRole(actor, 'manager')).toBe(false)
      expect(canCreateUserAtRole(actor, 'senior_manager')).toBe(false)
      expect(canCreateUserAtRole(actor, 'ceo')).toBe(false)
    }
    // Manager cannot create accounts at all (no user.invite).
    expect(canCreateUserAtRole('manager', 'sales_executive')).toBe(false)
  })

  it('CEO, Senior Manager and Manager can manage users by role', () => {
    for (const r of ['ceo', 'senior_manager', 'manager'] as Role[]) {
      expect(canManageUsers(r, [])).toBe(true)
    }
    expect(canManageUsers('sales_executive', [])).toBe(false)
    expect(canManageUsers('virtual_assistant', [])).toBe(false)
  })

  it('a granted user.manage permission lifts a lower role into managing users', () => {
    expect(canManageUsers('sales_executive', ['user.manage'])).toBe(true)
    expect(canManageUsers('virtual_assistant', ['user.manage'])).toBe(true)
    // An unrelated grant does not help.
    expect(canManageUsers('sales_executive', ['something.else'])).toBe(false)
  })

  it('only grantable actions can be lifted by a grant', () => {
    expect(isGrantableAction('user.manage')).toBe(true)
    expect(isGrantableAction('user.invite')).toBe(false)
    // user.invite is deny-listed — a per-user grant string cannot lift it. Use
    // manager (who has no base user.invite) so the grant, not the base role, is
    // what's under test.
    expect(hasAction('manager', ['user.invite'], 'user.invite')).toBe(false)
  })

  it('CEO, Senior Manager and Manager can delegate the manage permission', () => {
    expect(canGrantUserManage('ceo')).toBe(true)
    expect(canGrantUserManage('senior_manager')).toBe(true)
    expect(canGrantUserManage('manager')).toBe(true)
    expect(canGrantUserManage('sales_executive')).toBe(false)
  })

  it('only CEO and Senior Manager can deactivate users', () => {
    expect(canDeactivateUsers('ceo')).toBe(true)
    expect(canDeactivateUsers('senior_manager')).toBe(true)
    expect(canDeactivateUsers('manager')).toBe(false)
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

describe('custom-role permissions (assignable set + sanitize)', () => {
  const CATASTROPHIC = [
    'secrets.rotate',
    'tenant.config.write',
    'user.role.grant_ceo',
    'user.role.grant_senior_manager',
    'user.role.revoke_senior_manager',
    'user.deactivate',
    'user.invite',
    'user.grant_manage',
    'dsar.export',
  ] as const

  it('the deny-list and assignable set partition every action', () => {
    for (const a of DENY_LIST_ACTIONS) expect(isAssignableAction(a)).toBe(false)
    for (const a of ASSIGNABLE_ACTIONS) expect(isAssignableAction(a)).toBe(true)
    // Together they cover every ACTION exactly once.
    expect(ASSIGNABLE_ACTIONS.length + DENY_LIST_ACTIONS.length).toBe(ACTIONS.length)
  })

  it('never lets a catastrophic action into a role, even if the actor holds it', () => {
    // A CEO effectively holds every action; the deny-list is still stripped.
    const ceoEffective = [...ACTIONS]
    const cleaned = sanitizeRolePermissions(ceoEffective, [...CATASTROPHIC, 'charge.refund'])
    for (const a of CATASTROPHIC) expect(cleaned).not.toContain(a)
    expect(cleaned).toEqual(['charge.refund'])
  })

  it('forbids privilege escalation — you can only bundle what you hold', () => {
    // A sales-level actor (who lacks audit.read) cannot mint a role that reads
    // the audit log. (family.merge / settings.write are now held by sales, so
    // audit.read is the assignable action sales does NOT hold — see §20.)
    const salesEffective = ACTIONS.filter((a) => roleCan('sales_executive', a))
    const cleaned = sanitizeRolePermissions(salesEffective, ['audit.read', 'contact.write'])
    expect(cleaned).not.toContain('audit.read')
    expect(cleaned).toContain('contact.write')
  })

  it('hasAction honours an assignable grant from a custom role', () => {
    // sales_executive base role cannot read the audit log…
    expect(hasAction('sales_executive', [], 'audit.read')).toBe(false)
    // …but a custom role granting audit.read makes it pass.
    expect(hasAction('sales_executive', ['audit.read'], 'audit.read')).toBe(true)
    // A deny-list action can never be satisfied by a grant.
    expect(hasAction('sales_executive', ['secrets.rotate'], 'secrets.rotate')).toBe(false)
  })
})
