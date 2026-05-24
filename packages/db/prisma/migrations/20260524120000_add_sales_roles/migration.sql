-- Slice 2 of the sales-CRM pivot. See ADR 0014.
--
-- Appends the new sales-focused role names to the UserRole enum and
-- migrates every existing RoleAssignment to the new vocabulary. The legacy
-- enum values (admin, super_admin, ops_manager, agent, finance, dsl,
-- read_only) are RETAINED in the enum per CLAUDE.md §19 forward-only
-- schema rule. The `pickPrimaryRole` helper in packages/core/auth/policies
-- normalises any straggler legacy assignment at read time.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ceo';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'senior_manager';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'manager';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'sales_executive';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'virtual_assistant';
