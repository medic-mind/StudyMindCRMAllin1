// Settings → Users + Roles. RSC, admin/super_admin only. CLAUDE.md §20.
//
// Lists users with their roles, last sign-in, and status. Pending invites
// surface in their own section. Action buttons are filtered by what the
// caller can grant or revoke.

import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { InviteDialog, UserRoleControls } from './controls'

export const dynamic = 'force-dynamic'

interface PageSearchParams {
  q?: string
  cursor?: string
}

export default async function UsersSettingsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>
}) {
  const sp = await searchParams
  const me = await getCurrentUser()
  const role = me?.role ?? 'agent'
  if (role !== 'admin' && role !== 'super_admin') {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users &amp; roles</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Restricted to administrators.
        </p>
      </div>
    )
  }

  const caller = await createServerCaller()
  const data = await caller.admin.users.list({
    search: sp.q && sp.q.trim() ? sp.q.trim() : undefined,
    cursor: sp.cursor,
    limit: 50,
  })

  const pending = data.items.filter((u) => u.status === 'invited')
  const active = data.items.filter((u) => u.status !== 'invited')

  const superAdmins = data.items.filter((u) =>
    u.roles.some((r) => r.role === 'super_admin'),
  )
  const lastSuperAdminWarning =
    role === 'super_admin' && superAdmins.length === 1
      ? 'You are the only super_admin. Add another before stepping down.'
      : null

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Users &amp; roles</h1>
        <Link href="/settings" className="text-sm text-neutral-600 underline">
          Back to settings
        </Link>
      </div>

      {lastSuperAdminWarning && (
        <div
          className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          {lastSuperAdminWarning}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <form className="flex gap-2" method="GET">
          <Input
            type="search"
            name="q"
            defaultValue={sp.q ?? ''}
            placeholder="Search by email or name"
            className="max-w-sm"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <div className="ml-auto">
          <InviteDialog actorRole={role} />
        </div>
      </div>

      {pending.length > 0 && (
        <div className="mt-6 rounded-md border border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-800">
            Pending invites
          </div>
          <Table>
            <Thead>
              <Tr>
                <Th>Email</Th>
                <Th>Name</Th>
                <Th>Roles</Th>
                <Th>Manage</Th>
              </Tr>
            </Thead>
            <Tbody>
              {pending.map((u) => (
                <Tr key={u.id}>
                  <Td className="font-mono text-xs">{u.email}</Td>
                  <Td>{u.name ?? '—'}</Td>
                  <Td>
                    <RoleChips roles={u.roles.map((r) => r.role)} />
                  </Td>
                  <Td>
                    <UserRoleControls
                      userId={u.id}
                      currentRoles={u.roles.map((r) => r.role)}
                      status={u.status}
                      actorRole={role}
                      isSelf={u.id === me?.id}
                    />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </div>
      )}

      <div className="mt-6 rounded-md border border-neutral-200 bg-white">
        {active.length === 0 ? (
          <div className="p-6 text-sm text-neutral-600">
            No users found — invite a colleague to get started.
          </div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Email</Th>
                <Th>Name</Th>
                <Th>Roles</Th>
                <Th>Last sign-in</Th>
                <Th>Status</Th>
                <Th>Manage</Th>
              </Tr>
            </Thead>
            <Tbody>
              {active.map((u) => (
                <Tr key={u.id}>
                  <Td className="font-mono text-xs">{u.email}</Td>
                  <Td>{u.name ?? '—'}</Td>
                  <Td>
                    <RoleChips roles={u.roles.map((r) => r.role)} />
                  </Td>
                  <Td className="text-xs text-neutral-600">
                    {u.lastSignInAt
                      ? new Date(u.lastSignInAt).toLocaleString('en-GB')
                      : '—'}
                  </Td>
                  <Td>
                    <StatusChip status={u.status} />
                  </Td>
                  <Td>
                    <UserRoleControls
                      userId={u.id}
                      currentRoles={u.roles.map((r) => r.role)}
                      status={u.status}
                      actorRole={role}
                      isSelf={u.id === me?.id}
                    />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>
    </div>
  )
}

function RoleChips({ roles }: { roles: string[] }) {
  if (roles.length === 0) return <span className="text-neutral-400">none</span>
  return (
    <span className="space-x-1">
      {roles.map((r) => (
        <span
          key={r}
          className="inline-block rounded bg-neutral-100 px-2 py-0.5 text-xs"
        >
          {r}
        </span>
      ))}
    </span>
  )
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-green-100 text-green-800'
      : status === 'locked'
        ? 'bg-red-100 text-red-800'
        : status === 'deactivated'
          ? 'bg-neutral-200 text-neutral-700'
          : 'bg-amber-100 text-amber-800'
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs ${tone}`}>{status}</span>
  )
}
