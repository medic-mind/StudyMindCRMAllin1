-- Slice 2 of the sales-CRM pivot. See ADR 0014.
--
-- Bulk-converts every existing RoleAssignment row from the legacy
-- super_admin/admin/ops_manager/agent/finance/dsl/read_only vocabulary to the
-- new sales-focused names. Mapping (per ADR 0014):
--
--   super_admin   -> ceo
--   admin         -> senior_manager
--   ops_manager   -> manager
--   finance       -> manager
--   dsl           -> manager
--   agent         -> sales_executive
--   read_only     -> virtual_assistant
--
-- Run AFTER 20260524120000_add_sales_roles which appends the new enum values.
-- ALTER TYPE ... ADD VALUE values are not usable in the same transaction as
-- their commit, so the data migration must live in its own migration file.
--
-- The legacy enum values stay in the UserRole enum (CLAUDE.md §19 forward-only
-- rule). pickPrimaryRole in apps/web/lib/auth/pick-primary-role.ts normalises
-- any straggler legacy assignment at read time, so this UPDATE is the bulk
-- conversion path but not the only line of defence.
--
-- The @@unique([userId, role]) constraint on RoleAssignment means a user who
-- (somehow) already held BOTH a legacy role and its target canonical role
-- would collide on update. We delete those legacy duplicates first to keep the
-- migration deterministic. Today no such rows exist in any environment, but
-- the guard costs nothing and makes the migration safe to re-run on a
-- partially-migrated database.

-- Drop any legacy RoleAssignment whose user already has the target canonical role.
DELETE FROM "RoleAssignment" ra_legacy
USING "RoleAssignment" ra_new
WHERE ra_legacy."userId" = ra_new."userId"
  AND (
    (ra_legacy.role = 'super_admin'  AND ra_new.role = 'ceo')             OR
    (ra_legacy.role = 'admin'        AND ra_new.role = 'senior_manager')  OR
    (ra_legacy.role = 'ops_manager'  AND ra_new.role = 'manager')         OR
    (ra_legacy.role = 'finance'      AND ra_new.role = 'manager')         OR
    (ra_legacy.role = 'dsl'          AND ra_new.role = 'manager')         OR
    (ra_legacy.role = 'agent'        AND ra_new.role = 'sales_executive') OR
    (ra_legacy.role = 'read_only'    AND ra_new.role = 'virtual_assistant')
  );

-- ops_manager, finance, and dsl all collapse to `manager`. A user holding
-- two of those legacy roles would also collide on the @@unique constraint
-- when both rows try to become `manager`. Collapse legacy duplicates first.
DELETE FROM "RoleAssignment" ra_keep
USING "RoleAssignment" ra_drop
WHERE ra_keep."userId" = ra_drop."userId"
  AND ra_keep.id > ra_drop.id
  AND ra_keep.role IN ('ops_manager', 'finance', 'dsl')
  AND ra_drop.role IN ('ops_manager', 'finance', 'dsl');

UPDATE "RoleAssignment" SET role = 'ceo'               WHERE role = 'super_admin';
UPDATE "RoleAssignment" SET role = 'senior_manager'    WHERE role = 'admin';
UPDATE "RoleAssignment" SET role = 'manager'           WHERE role IN ('ops_manager', 'finance', 'dsl');
UPDATE "RoleAssignment" SET role = 'sales_executive'   WHERE role = 'agent';
UPDATE "RoleAssignment" SET role = 'virtual_assistant' WHERE role = 'read_only';
