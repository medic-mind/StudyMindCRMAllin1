'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

const COLOR_PRESETS = ['#9333ea', '#2563eb', '#059669', '#d97706', '#dc2626', '#0891b2']

function TeamRow({ teamId }: { teamId: string }) {
  const router = useRouter()
  const team = trpc.team.get.useQuery({ id: teamId })
  const users = trpc.task.assignableUsers.useQuery({})
  const addMember = trpc.team.addMember.useMutation()
  const removeMember = trpc.team.removeMember.useMutation()
  const archive = trpc.team.archive.useMutation()
  const restore = trpc.team.restore.useMutation()
  const [adding, setAdding] = useState<string>('')

  if (team.isLoading) {
    return <div className="px-4 py-3 text-sm text-neutral-500">Loading…</div>
  }
  const t = team.data
  if (!t) return null
  const memberIds = new Set(t.members.map((m) => m.userId))
  const eligible = (users.data ?? []).filter((u) => !memberIds.has(u.id))

  async function add() {
    if (!adding) return
    try {
      await addMember.mutateAsync({ teamId, userId: adding })
      setAdding('')
      await team.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add')
    }
  }

  async function remove(userId: string) {
    try {
      await removeMember.mutateAsync({ teamId, userId })
      await team.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove')
    }
  }

  async function toggleArchive() {
    const current = team.data
    if (!current) return
    try {
      if (current.archived) {
        await restore.mutateAsync({ id: teamId })
        toast.success('Team restored')
      } else {
        await archive.mutateAsync({ id: teamId })
        toast.success('Team archived')
      }
      await team.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change')
    }
  }

  return (
    <div className="space-y-3 border-t border-neutral-200 bg-neutral-50/40 px-4 py-3">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Members ({t.members.length})
        </h4>
        {t.members.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-500">No members yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-white">
            {t.members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                <Avatar name={m.name ?? m.email ?? '?'} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-900">
                    {m.name ?? m.email}
                  </div>
                  {m.name ? (
                    <div className="truncate text-xs text-neutral-500">{m.email}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => remove(m.userId)}
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove member"
                >
                  <XIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label className="text-xs">Add member</Label>
          <Select value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Pick a user…</option>
            {eligible.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ? `${u.name} (${u.email})` : u.email}
              </option>
            ))}
          </Select>
        </div>
        <Button type="button" size="sm" disabled={!adding || addMember.isPending} onClick={add}>
          {addMember.isPending ? 'Adding…' : 'Add'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={toggleArchive}>
          {t.archived ? 'Restore team' : 'Archive team'}
        </Button>
      </div>
    </div>
  )
}

export function TeamsAdmin() {
  const router = useRouter()
  const teams = trpc.team.list.useQuery({ includeArchived: true })
  const create = trpc.team.create.useMutation()
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(COLOR_PRESETS[0]!)
  const [description, setDescription] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    try {
      const result = await create.mutateAsync({
        name: name.trim(),
        color,
        description: description.trim() || undefined,
      })
      toast.success('Team created')
      setName('')
      setDescription('')
      setExpanded(result.id)
      await teams.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create team')
    }
  }

  const data = teams.data ?? []

  return (
    <div className="space-y-5">
      <form
        onSubmit={onCreate}
        className="space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-card"
      >
        <h2 className="text-sm font-semibold text-neutral-900">New team</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="teamName">Name</Label>
            <Input
              id="teamName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Onboarding, Retention, Year 11 ops…"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Colour</Label>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PRESETS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={`Pick ${c}`}
                  className={`h-7 w-7 rounded-full border-2 transition-transform ${
                    color === c ? 'border-neutral-900 scale-110' : 'border-white shadow'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="teamDescription">Description (optional)</Label>
          <Input
            id="teamDescription"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending ? 'Creating…' : 'Create team'}
          </Button>
        </div>
      </form>

      <Card className="overflow-hidden">
        {data.length === 0 ? (
          <p className="p-6 text-sm text-neutral-500">
            No teams yet. Create one above to start scoping tasks per squad.
          </p>
        ) : (
          <ul>
            {data.map((t) => (
              <li key={t.id} className="border-b border-neutral-100 last:border-b-0">
                <button
                  type="button"
                  onClick={() => setExpanded((cur) => (cur === t.id ? null : t.id))}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-primary-50/30"
                >
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: t.color ?? '#94a3b8' }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-neutral-900">{t.name}</span>
                      {t.archived ? <Badge tone="neutral">Archived</Badge> : null}
                    </div>
                    {t.description ? (
                      <div className="truncate text-xs text-neutral-500">{t.description}</div>
                    ) : null}
                  </div>
                  <span className="text-xs text-neutral-500">
                    {t.memberCount} member{t.memberCount === 1 ? '' : 's'}
                  </span>
                </button>
                {expanded === t.id ? <TeamRow teamId={t.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
