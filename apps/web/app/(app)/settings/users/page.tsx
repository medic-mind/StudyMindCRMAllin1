// Settings → Users. RSC. Visible to anyone who can manage users (ADR 0021):
// CEO, Senior Manager, Manager, or an individual granted `user.manage`.
//
// Lists users with avatar, role + status badges, relative last-seen, and a
// per-row "⋯" actions menu. Status filter tabs narrow the view; a banner warns
// when the system Gmail mailbox isn't connected (so welcome emails won't send).

import Link from 'next/link'

import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { formatRoleLabel } from '@/lib/format/role-label'

import { CreateUserDialog, RowActions, type AccessFlags } from './controls'

export const dynamic = 'force-dynamic'

type StatusFilter = 'all' | 'active' | 'invited' | 'deactivated'

interface PageSearchParams {
  q?: string
  cursor?: string
  status?: string
}

const MANAGE_BY_ROLE = new Set(['ceo', 'senior_manager', 'manager'])
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'invited', label: 'Invited' },
  { key: 'deactivated', label: 'Deactivated' },
]

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

  const status: StatusFilter = (['all', 'active', 'invited', 'deactivated'] as const).includes(
    sp.status as StatusFilter,
  )
    ? (sp.status as StatusFilter)
    : 'all'

  const counts = {
    all: data.items.length,
    active: data.items.filter((u) => u.status === 'active' || u.status === 'locked').length,
    invited: data.items.filter((u) => u.status === 'invited').length,
    deactivated: data.items.filter((u) => u.status === 'deactivated').length,
  }
  const rows = data.items.filter((u) => {
    if (status === 'all') return true
    if (status === 'active') return u.status === 'active' || u.status === 'locked'
    return u.status === status
  })

  const ceos = data.items.filter((u) => u.roles.some((r) => r.role === 'ceo'))
  const lastCeoWarning =
    access.role === 'ceo' && ceos.length <= 1
      ? 'You are the only CEO. Add another before stepping down.'
      : null

  const tabHref = (key: StatusFilter) => {
    const params = new URLSearchParams()
    if (sp.q) params.set('q', sp.q)
    if (key !== 'all') params.set('status', key)
    const qs = params.toString()
    return `/settings/users${qs ? `?${qs}` : ''}`
  }

  return (
    <>
      <PageHeader
        title="Users settings"
        breadcrumbs={[
          { label: 'Settings', href: '/settings' },
          { label: 'Users', href: '/settings/users' },
        ]}
      />

      {access.systemEmailReady === false && (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="status"
        >
          System email isn&rsquo;t connected yet, so new users won&rsquo;t receive their welcome
          email automatically. When you create or reset an account, copy the temporary password and
          share it securely.{' '}
          <Link href="/settings/mailbox" className="font-medium underline">
            Connect Gmail →
          </Link>
        </div>
      )}

      {lastCeoWarning && (
        <div
          className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          {lastCeoWarning}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* status filters — navigation links, not an ARIA tab widget */}
        <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
          {FILTERS.map((f) => {
            const activeTab = f.key === status
            return (
              <Link
                key={f.key}
                href={tabHref(f.key)}
                aria-current={activeTab ? 'page' : undefined}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  activeTab
                    ? 'bg-primary-600 text-white'
                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                }`}
              >
                {f.label} <span className="opacity-70">{counts[f.key]}</span>
              </Link>
            )
          })}
        </nav>

        <form className="ml-auto flex gap-2" method="GET">
          {status !== 'all' && <input type="hidden" name="status" value={status} />}
          <Input
            type="search"
            name="q"
            defaultValue={sp.q ?? ''}
            placeholder="Search by email or name"
            className="max-w-xs"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <CreateUserDialog access={access} />
      </div>

      {!access.canCreate && (
        <p className="mt-2 text-xs text-neutral-500">
          Only a CEO or Senior Manager can create accounts. You can edit details and reset passwords
          for the users you manage.
        </p>
      )}

      <div className="mt-4 rounded-md border border-neutral-200 bg-white">
        {rows.length === 0 ? (
          <div className="p-6 text-sm text-neutral-600">
            {status === 'all'
              ? access.canCreate
                ? 'No users yet — add a colleague to get started.'
                : 'No users to show.'
              : `No ${status} users.`}
          </div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                {/* User column is greedy (w-full) so the metadata columns hug
                    their content instead of sprawling on wide screens. */}
                <Th className="w-full">User</Th>
                <Th className="whitespace-nowrap">Roles</Th>
                <Th className="whitespace-nowrap">Last seen</Th>
                <Th className="whitespace-nowrap">Status</Th>
                <Th className="whitespace-nowrap text-right">Actions</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((u) => (
                <Tr key={u.id}>
                  <Td className="w-full">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.name || u.email} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-neutral-900">
                          {u.name ?? u.email.split('@')[0]}
                        </div>
                        <div className="truncate font-mono text-xs text-neutral-500">{u.email}</div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <RoleBadges roles={u.roles.map((r) => r.role)} extraPermissions={u.extraPermissions} />
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-neutral-600">
                    {relativeTime(u.lastSignInAt)}
                  </Td>
                  <Td>
                    <StatusBadge status={u.status} awaitingFirstSignIn={u.awaitingFirstSignIn} />
                  </Td>
                  <Td>
                    <RowActions
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

function RoleBadges({
  roles,
  extraPermissions,
}: {
  roles: string[]
  extraPermissions: string[]
}) {
  const showManagerBadge =
    extraPermissions.includes('user.manage') && !roles.some((r) => MANAGE_BY_ROLE.has(r))
  if (roles.length === 0 && !showManagerBadge) {
    return <span className="text-xs text-neutral-400">none</span>
  }
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Badge key={r} tone="neutral">
          {formatRoleLabel(r)}
        </Badge>
      ))}
      {showManagerBadge && (
        <Badge tone="warn" dot>
          User manager
        </Badge>
      )}
    </span>
  )
}

function StatusBadge({
  status,
  awaitingFirstSignIn,
}: {
  status: string
  awaitingFirstSignIn?: boolean
}) {
  if (status === 'active' && awaitingFirstSignIn) {
    return (
      <Badge tone="info" dot>
        Awaiting sign-in
      </Badge>
    )
  }
  const map: Record<string, { tone: BadgeTone; label: string }> = {
    active: { tone: 'success', label: 'Active' },
    locked: { tone: 'danger', label: 'Locked' },
    deactivated: { tone: 'neutral', label: 'Deactivated' },
    invited: { tone: 'warn', label: 'Invited' },
  }
  const s = map[status] ?? { tone: 'neutral' as BadgeTone, label: status }
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  )
}

function relativeTime(value: string | Date | null): string {
  if (!value) return 'never'
  const then = new Date(value).getTime()
  const diff = Date.now() - then
  if (Number.isNaN(then)) return 'never'
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return 'just now'
  if (diff < hour) return `${Math.floor(diff / min)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`
  return new Date(value).toLocaleDateString('en-GB')
}
