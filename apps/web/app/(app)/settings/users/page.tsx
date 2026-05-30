// Settings → Users. RSC. Visible to anyone who can manage users (ADR 0021):
// CEO, Senior Manager, Manager, or an individual granted `user.manage`.
//
// Lists users with their roles, last sign-in, and status. Pending invites
// surface in their own section. Per-row actions are filtered by the caller's
// capabilities; the server re-checks each one.

import { PageHeader } from '@/components/shell/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { formatRoleLabel } from '@/lib/format/role-label'

import { CreateUserDialog, UserRowControls, type AccessFlags } from './controls'

export const dynamic = 'force-dynamic'

interface PageSearchParams {
  q?: string
  cursor?: string
}

const MANAGE_BY_ROLE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function UsersSettingsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>
}) {
  const sp = await searchParams
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  const access = (await caller.admin.users.myAccess()) as AccessFlags

  if (!access.canManage) {
    return (
      <>
        <PageHeader
          title="Users settings"
          breadcrumbs={[
            { label: 'Settings', href: '/settings' },
            { label: 'Users', href: '/settings/users' },
          ]}
        />
        <p className="text-sm text-neutral-600">
          You do not have permission to manage users. Ask a CEO, Senior Manager, or Manager to grant
          you access.
        </p>
      </>
    )
  }

  const data = await caller.admin.users.list({
    search: sp.q && sp.q.trim() ? sp.q.trim() : undefined,
    cursor: sp.cursor,
    limit: 50,
  })

  const pending = data.items.filter((u) => u.status === 'invited')
  const active = data.items.filter((u) => u.status !== 'invited')

  const ceos = data.items.filter((u) => u.roles.some((r) => r.role === 'ceo'))
  const lastCeoWarning =
    access.role === 'ceo' && ceos.length <= 1
      ? 'You are the only CEO. Add another before stepping down.'
      : null

  return (
    <>
      <PageHeader
        title="Users settings"
        breadcrumbs={[
          { label: 'Settings', href: '/settings' },
          { label: 'Users', href: '/settings/users' },
        ]}
      />

      {lastCeoWarning && (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          {lastCeoWarning}
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
          <CreateUserDialog access={access} />
        </div>
      </div>

      {!access.canCreate && (
        <p className="mt-2 text-xs text-neutral-500">
          Only a CEO or Senior Manager can create accounts. You can edit details and reset passwords
          for the users you manage.
        </p>
      )}

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
                    <RoleChips roles={u.roles.map((r) => r.role)} extraPermissions={u.extraPermissions} />
                  </Td>
                  <Td>
                    <UserRowControls
                      userId={u.id}
                      email={u.email}
                      name={u.name}
                      currentRoles={u.roles.map((r) => r.role)}
                      extraPermissions={u.extraPermissions}
                      status={u.status}
                      isSelf={u.id === me?.id}
                      access={access}
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
            No users found — {access.canCreate ? 'add a colleague to get started.' : 'nothing to show.'}
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
                    <RoleChips roles={u.roles.map((r) => r.role)} extraPermissions={u.extraPermissions} />
                  </Td>
                  <Td className="text-xs text-neutral-600">
                    {u.lastSignInAt
                      ? new Date(u.lastSignInAt).toLocaleString('en-GB')
                      : '—'}
                  </Td>
                  <Td>
                    <StatusChip status={u.status} awaitingFirstSignIn={u.awaitingFirstSignIn} />
                  </Td>
                  <Td>
                    <UserRowControls
                      userId={u.id}
                      email={u.email}
                      name={u.name}
                      currentRoles={u.roles.map((r) => r.role)}
                      extraPermissions={u.extraPermissions}
                      status={u.status}
                      isSelf={u.id === me?.id}
                      access={access}
                    />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>
    </>
  )
}

function RoleChips({
  roles,
  extraPermissions,
}: {
  roles: string[]
  extraPermissions: string[]
}) {
  const showManagerBadge =
    extraPermissions.includes('user.manage') && !roles.some((r) => MANAGE_BY_ROLE.has(r))
  if (roles.length === 0 && !showManagerBadge) {
    return <span className="text-neutral-400">none</span>
  }
  return (
    <span className="space-x-1">
      {roles.map((r) => (
        <span key={r} className="inline-block rounded bg-neutral-100 px-2 py-0.5 text-xs">
          {formatRoleLabel(r)}
        </span>
      ))}
      {showManagerBadge && (
        <span
          className="inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900"
          title="Granted permission to manage users"
        >
          User manager
        </span>
      )}
    </span>
  )
}

function StatusChip({
  status,
  awaitingFirstSignIn,
}: {
  status: string
  awaitingFirstSignIn?: boolean
}) {
  if (status === 'active' && awaitingFirstSignIn) {
    return (
      <span
        className="inline-block rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800"
        title="Created — awaiting first sign-in and password reset"
      >
        awaiting first sign-in
      </span>
    )
  }
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
