// Settings → Users + Roles. RSC, admin-only.
// CLAUDE.md §20 (RBAC), §27 (audit context).

import { legacyAuth as auth } from '@/lib/auth/server'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { UserRoleControls } from './controls'

export const dynamic = 'force-dynamic'

interface PageSearchParams {
  q?: string
  cursorId?: string
}

export default async function UsersSettingsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>
}) {
  const sp = await searchParams
  const { sessionClaims } = await auth()
  const role = (sessionClaims?.['role'] as string | undefined) ?? 'agent'
  if (role !== 'admin') {
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
    q: sp.q && sp.q.trim() ? sp.q.trim() : undefined,
    cursorId: sp.cursorId,
    limit: 50,
  })

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Users &amp; roles</h1>
        <Link href="/settings" className="text-sm text-neutral-600 underline">
          Back to settings
        </Link>
      </div>

      <form className="mt-4 flex gap-2" method="GET">
        <Input
          type="search"
          name="q"
          defaultValue={sp.q ?? ''}
          placeholder="Search by email"
          className="max-w-sm"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      <div className="mt-6 rounded-md border border-neutral-200 bg-white">
        {data.items.length === 0 ? (
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
                <Th>Manage</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data.items.map((u) => (
                <Tr key={u.id}>
                  <Td className="font-mono text-xs">{u.email}</Td>
                  <Td>{u.name ?? '—'}</Td>
                  <Td>
                    {u.roles.length === 0 ? (
                      <span className="text-neutral-400">none</span>
                    ) : (
                      <span className="space-x-1">
                        {u.roles.map((r) => (
                          <span
                            key={r.id}
                            className="inline-block rounded bg-neutral-100 px-2 py-0.5 text-xs"
                          >
                            {r.role}
                          </span>
                        ))}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <UserRoleControls
                      userId={u.id}
                      currentRoles={u.roles.map((r) => r.role)}
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
