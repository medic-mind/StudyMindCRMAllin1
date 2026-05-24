// Settings → Users + Roles. RSC, ceo / senior_manager only. CLAUDE.md §20, ADR 0014.
//
// Lists users with their roles, last sign-in, and status. Pending invites
// surface in their own section. Action buttons are filtered by what the
// caller can grant or revoke.

import { PageHeader } from '@/components/shell/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { formatRoleLabel } from '@/lib/format/role-label'

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
  const role = me?.role ?? 'virtual_assistant'
  if (role !== 'ceo' && role !== 'senior_manager') {
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
          Restricted to administrators.
        </p>
      </>
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

  // A CEO is allowed to step down only once another CEO exists. Surface a
  // friendly warning if they are the only one. The router normalises legacy
  // role values to canonical before returning, so a check on `'ceo'` covers
  // both freshly-migrated and legacy rows.
  const ceos = data.items.filter((u) => u.roles.some((r) => r.role === 'ceo'))
  const lastCeoWarning =
    role === 'ceo' && ceos.length <= 1
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
    </>
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
          {formatRoleLabel(r)}
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
