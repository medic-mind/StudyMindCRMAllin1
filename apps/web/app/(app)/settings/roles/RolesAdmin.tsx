'use client'

import { Fragment, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CheckIcon, XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

const COLOR_PRESETS = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#dc2626', '#0891b2']

type Catalogue = {
  groups: {
    label: string
    actions: { action: string; label: string; assignable: boolean; canAssign: boolean }[]
  }[]
}

interface EditorValue {
  name: string
  description: string
  color: string
  permissions: Set<string>
}

function PermissionChecklist({
  catalogue,
  selected,
  onToggle,
}: {
  catalogue: Catalogue
  selected: Set<string>
  onToggle: (action: string) => void
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {catalogue.groups.map((g) => (
        <div key={g.label} className="rounded-lg border border-neutral-200 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {g.label}
          </div>
          <div className="flex flex-col gap-1.5">
            {g.actions.map((a) => {
              const locked = !a.assignable
              const disabled = locked || !a.canAssign
              return (
                <label
                  key={a.action}
                  className={`flex items-center gap-2 text-sm ${
                    disabled ? 'cursor-not-allowed text-neutral-400' : 'cursor-pointer text-neutral-700'
                  }`}
                  title={
                    locked
                      ? 'This permission is reserved for built-in senior roles'
                      : !a.canAssign
                        ? 'You can only hand out permissions you hold yourself'
                        : undefined
                  }
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500 disabled:opacity-50"
                    checked={selected.has(a.action)}
                    disabled={disabled}
                    onChange={() => onToggle(a.action)}
                  />
                  <span>{a.label}</span>
                  {locked ? (
                    <span className="ml-auto text-[10px] uppercase tracking-wide text-neutral-400">
                      locked
                    </span>
                  ) : null}
                </label>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function RoleEditor({
  catalogue,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  catalogue: Catalogue
  initial: EditorValue
  busy: boolean
  onSave: (v: EditorValue) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [color, setColor] = useState(initial.color)
  const [permissions, setPermissions] = useState<Set<string>>(new Set(initial.permissions))

  function toggle(action: string) {
    setPermissions((prev) => {
      const next = new Set(prev)
      if (next.has(action)) next.delete(action)
      else next.add(action)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-neutral-50/60 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="role-name">Name</Label>
          <Input
            id="role-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Refund handler"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role-desc">Description (optional)</Label>
          <Input
            id="role-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this role is for"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Colour</Label>
        <div className="flex gap-2">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              onClick={() => setColor(c)}
              className={`h-6 w-6 rounded-full ring-2 ring-offset-1 ${
                color === c ? 'ring-neutral-500' : 'ring-transparent'
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Permissions</Label>
        <PermissionChecklist catalogue={catalogue} selected={permissions} onToggle={toggle} />
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || name.trim().length < 2}
          onClick={() => onSave({ name, description, color, permissions })}
        >
          {busy ? 'Saving…' : 'Save role'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function MemberManager({ customRoleId }: { customRoleId: string }) {
  const members = trpc.role.members.useQuery({ customRoleId })
  const [q, setQ] = useState('')
  const candidates = trpc.role.assignableUsers.useQuery({ q: q || undefined })
  const assign = trpc.role.assignToUser.useMutation()
  const unassign = trpc.role.unassignFromUser.useMutation()

  const memberIds = useMemo(
    () => new Set((members.data ?? []).map((m) => m.id)),
    [members.data],
  )

  async function add(userId: string) {
    try {
      await assign.mutateAsync({ customRoleId, userId })
      setQ('')
      await members.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not assign')
    }
  }
  async function remove(userId: string) {
    try {
      await unassign.mutateAsync({ customRoleId, userId })
      await members.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove')
    }
  }

  const eligible = (candidates.data ?? []).filter((u) => !memberIds.has(u.id)).slice(0, 6)

  return (
    <div className="mt-3 rounded-lg border border-neutral-200 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Assigned people
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(members.data ?? []).length === 0 ? (
          <span className="text-sm text-neutral-500">Nobody yet.</span>
        ) : (
          (members.data ?? []).map((m) => (
            <span
              key={m.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 py-0.5 pl-2.5 pr-1 text-xs text-neutral-700"
            >
              {m.name ?? m.email}
              <button
                type="button"
                aria-label={`Remove ${m.email}`}
                onClick={() => remove(m.id)}
                className="rounded-full p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
              >
                <XIcon size={12} />
              </button>
            </span>
          ))
        )}
      </div>
      <div className="mt-3 space-y-1.5">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people by name or email…"
        />
        {q && eligible.length > 0 ? (
          <div className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200">
            {eligible.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => add(u.id)}
                className="flex items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
              >
                <span>
                  {u.name ?? u.email}
                  {u.name ? <span className="ml-1.5 text-neutral-400">{u.email}</span> : null}
                </span>
                <CheckIcon size={14} className="text-primary-600" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function RoleCard({
  role,
  catalogue,
  labelFor,
}: {
  role: {
    id: string
    name: string
    description: string | null
    color: string
    permissions: string[]
    memberCount: number
    archived: boolean
  }
  catalogue: Catalogue
  labelFor: (action: string) => string
}) {
  const [editing, setEditing] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const update = trpc.role.update.useMutation()
  const archive = trpc.role.archive.useMutation()
  const restore = trpc.role.restore.useMutation()
  const utils = trpc.useUtils()

  async function save(v: EditorValue) {
    try {
      await update.mutateAsync({
        id: role.id,
        name: v.name.trim(),
        description: v.description.trim() || null,
        color: v.color,
        permissions: [...v.permissions],
      })
      setEditing(false)
      await utils.role.list.invalidate()
      toast.success('Role updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    }
  }
  async function toggleArchive() {
    try {
      if (role.archived) await restore.mutateAsync({ id: role.id })
      else await archive.mutateAsync({ id: role.id })
      await utils.role.list.invalidate()
      toast.success(role.archived ? 'Role restored' : 'Role archived')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update')
    }
  }

  return (
    <Card variant="flat" className={role.archived ? 'opacity-70' : undefined}>
      <CardBody>
        {editing ? (
          <RoleEditor
            catalogue={catalogue}
            busy={update.isPending}
            initial={{
              name: role.name,
              description: role.description ?? '',
              color: role.color,
              permissions: new Set(role.permissions),
            }}
            onSave={save}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: role.color }}
                    aria-hidden
                  />
                  <span className="font-medium text-neutral-900">{role.name}</span>
                  {role.archived ? <Badge tone="neutral">Archived</Badge> : null}
                </div>
                {role.description ? (
                  <p className="mt-0.5 text-sm text-neutral-600">{role.description}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="xs" variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button size="xs" variant="ghost" onClick={toggleArchive}>
                  {role.archived ? 'Restore' : 'Archive'}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {role.permissions.length === 0 ? (
                <span className="text-xs text-neutral-400">No permissions yet</span>
              ) : (
                role.permissions.map((p) => (
                  <Badge key={p} tone="info">
                    {labelFor(p)}
                  </Badge>
                ))
              )}
            </div>
            <div>
              <Button size="xs" variant="ghost" onClick={() => setShowMembers((v) => !v)}>
                {showMembers ? 'Hide people' : `People (${role.memberCount})`}
              </Button>
            </div>
            {showMembers ? <MemberManager customRoleId={role.id} /> : null}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function BuiltInMatrix() {
  const matrix = trpc.role.matrix.useQuery()
  const [open, setOpen] = useState(false)
  if (!matrix.data) return null
  const { roles, groups } = matrix.data
  return (
    <Card>
      <CardHeader>
        <CardTitle>Built-in roles</CardTitle>
        <Button size="xs" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide matrix' : 'Show matrix'}
        </Button>
      </CardHeader>
      {open ? (
        <CardBody className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white px-3 py-2 text-left font-medium text-neutral-500">
                  Permission
                </th>
                {roles.map((r) => (
                  <th key={r.role} className="px-3 py-2 text-center font-medium text-neutral-500">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.label}>
                  <tr>
                    <td
                      colSpan={roles.length + 1}
                      className="bg-neutral-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-500"
                    >
                      {g.label}
                    </td>
                  </tr>
                  {g.actions.map((a) => (
                    <tr key={a.action} className="border-t border-neutral-100">
                      <td className="px-3 py-1.5 text-neutral-700">{a.label}</td>
                      {a.grants.map((granted, i) => (
                        <td key={i} className="px-3 py-1.5 text-center">
                          {granted ? (
                            <CheckIcon size={14} className="mx-auto text-emerald-600" />
                          ) : (
                            <span className="text-neutral-300">—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </CardBody>
      ) : null}
    </Card>
  )
}

export function RolesAdmin() {
  const list = trpc.role.list.useQuery({ includeArchived: true })
  const catalogueQuery = trpc.role.permissionCatalogue.useQuery()
  const create = trpc.role.create.useMutation()
  const utils = trpc.useUtils()
  const [creating, setCreating] = useState(false)

  const labelFor = useMemo(() => {
    const map = new Map<string, string>()
    for (const g of catalogueQuery.data?.groups ?? []) {
      for (const a of g.actions) map.set(a.action, a.label)
    }
    return (action: string) => map.get(action) ?? action
  }, [catalogueQuery.data])

  async function createRole(v: EditorValue) {
    try {
      await create.mutateAsync({
        name: v.name.trim(),
        description: v.description.trim() || undefined,
        color: v.color,
        permissions: [...v.permissions],
      })
      setCreating(false)
      await utils.role.list.invalidate()
      toast.success('Role created')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create')
    }
  }

  const catalogue = catalogueQuery.data ?? { groups: [] }
  const roles = list.data ?? []

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Custom roles</CardTitle>
          {!creating ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              New role
            </Button>
          ) : null}
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-sm text-neutral-600">
            Custom roles add permissions on top of a person&rsquo;s built-in role. They can only
            grant what you can do yourself, and never the sensitive actions reserved for CEO /
            Senior Manager.
          </p>
          {creating ? (
            <RoleEditor
              catalogue={catalogue}
              busy={create.isPending}
              initial={{ name: '', description: '', color: COLOR_PRESETS[0]!, permissions: new Set() }}
              onSave={createRole}
              onCancel={() => setCreating(false)}
            />
          ) : null}
          {list.isLoading ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : roles.length === 0 && !creating ? (
            <p className="text-sm text-neutral-500">
              No custom roles yet — create one to grant a bundle of permissions to a group of people.
            </p>
          ) : (
            roles.map((r) => (
              <RoleCard key={r.id} role={r} catalogue={catalogue} labelFor={labelFor} />
            ))
          )}
        </CardBody>
      </Card>

      <BuiltInMatrix />
    </div>
  )
}
