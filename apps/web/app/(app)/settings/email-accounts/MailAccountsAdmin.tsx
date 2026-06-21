'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { CheckCircleIcon, MailIcon, UsersIcon, XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

type Status = 'connected' | 'needs_reconnect' | 'disconnected' | 'error'

const STATUS_TONE: Record<Status, BadgeTone> = {
  connected: 'success',
  needs_reconnect: 'warn',
  disconnected: 'neutral',
  error: 'danger',
}

const STATUS_LABEL: Record<Status, string> = {
  connected: 'Connected',
  needs_reconnect: 'Reconnect needed',
  disconnected: 'Disconnected',
  error: 'Error',
}

function SharedMembers({ accountId }: { accountId: string }) {
  const account = trpc.mailAccount.get.useQuery({ id: accountId })
  const users = trpc.task.assignableUsers.useQuery({})
  const add = trpc.mailAccount.members.add.useMutation()
  const remove = trpc.mailAccount.members.remove.useMutation()
  const [adding, setAdding] = useState('')

  if (account.isLoading) {
    return <div className="px-4 py-3 text-sm text-neutral-500">Loading…</div>
  }
  const data = account.data
  if (!data) return null
  const memberIds = new Set(data.members.map((m) => m.userId))
  const eligible = (users.data ?? []).filter((u) => !memberIds.has(u.id))

  async function onAdd() {
    if (!adding) return
    try {
      await add.mutateAsync({ mailAccountId: accountId, userId: adding, access: 'agent' })
      setAdding('')
      await account.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add member')
    }
  }

  async function onRemove(userId: string) {
    try {
      await remove.mutateAsync({ mailAccountId: accountId, userId })
      await account.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove member')
    }
  }

  return (
    <div className="space-y-3 border-t border-neutral-200 bg-neutral-50/40 px-4 py-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Who can use this inbox ({data.members.length})
      </h4>
      {data.members.length === 0 ? (
        <p className="text-sm text-neutral-500">No one yet — add an agent below.</p>
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-white">
          {data.members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-neutral-900">
                  {m.name ?? m.email ?? m.userId}
                </div>
                {m.name && m.email ? (
                  <div className="truncate text-xs text-neutral-500">{m.email}</div>
                ) : null}
              </div>
              <Badge tone="neutral">{m.access}</Badge>
              <button
                type="button"
                onClick={() => onRemove(m.userId)}
                className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600"
                aria-label="Remove member"
              >
                <XIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label className="text-xs">Add agent</Label>
          <Select value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Pick a user…</option>
            {eligible.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ? `${u.name} (${u.email})` : u.email}
              </option>
            ))}
          </Select>
        </div>
        <Button type="button" size="sm" disabled={!adding || add.isPending} onClick={onAdd}>
          {add.isPending ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </div>
  )
}

export function MailAccountsAdmin({ canManage, meId }: { canManage: boolean; meId: string }) {
  const router = useRouter()
  const accounts = trpc.mailAccount.list.useQuery()
  const providers = trpc.mailAccount.providers.useQuery()
  const teams = trpc.team.pickList.useQuery()
  const sync = trpc.mailAccount.syncFromGmail.useMutation()
  const create = trpc.mailAccount.createShared.useMutation()
  const setDefault = trpc.mailAccount.setDefault.useMutation()
  const disconnect = trpc.mailAccount.disconnect.useMutation()
  const resync = trpc.mailAccount.resyncFromGmail.useMutation()

  const [provider, setProvider] = useState('gmail')
  const [address, setAddress] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [teamId, setTeamId] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  async function onSync() {
    try {
      const r = await sync.mutateAsync()
      toast.success(
        r.imported === 0
          ? 'No connected Gmail mailboxes found. Connect one first.'
          : `Imported ${r.imported} Gmail mailbox${r.imported === 1 ? '' : 'es'}.`,
      )
      await accounts.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not import')
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!address.trim()) return
    try {
      await create.mutateAsync({
        provider: provider as 'gmail' | 'google_workspace' | 'outlook' | 'exchange' | 'imap',
        address: address.trim(),
        displayName: displayName.trim() || undefined,
        teamId: teamId || undefined,
      })
      toast.success('Shared inbox added')
      setAddress('')
      setDisplayName('')
      setTeamId('')
      await accounts.refetch()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add shared inbox')
    }
  }

  async function onSetDefault(id: string) {
    try {
      await setDefault.mutateAsync({ id })
      await accounts.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not set default')
    }
  }

  async function onDisconnect(id: string) {
    try {
      await disconnect.mutateAsync({ id })
      toast.success('Account removed from the hub')
      await accounts.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove account')
    }
  }

  async function onResync(id: string) {
    try {
      await resync.mutateAsync({ id })
      toast.success('Resyncing from Gmail — archived state + labels will update shortly.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start resync')
    }
  }

  const rows = accounts.data ?? []
  const providerList = providers.data ?? []

  return (
    <div className="space-y-5">
      {/* Connect personal mailbox */}
      <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Your mailboxes</h2>
            <p className="mt-0.5 text-sm text-neutral-600">
              Connect your Gmail under{' '}
              <Link href="/settings/mailbox" className="text-primary-700 underline">
                My mailboxes
              </Link>
              , then import it here so it joins the Communications Hub.
            </p>
          </div>
          <Button type="button" size="sm" variant="secondary" disabled={sync.isPending} onClick={onSync}>
            {sync.isPending ? 'Importing…' : 'Import connected Gmail'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {providerList.map((p) => (
            <Badge key={p.id} tone={p.connectable ? 'success' : 'neutral'}>
              {p.label}
              {p.connectable ? '' : ' · soon'}
            </Badge>
          ))}
        </div>
      </div>

      {/* Add shared inbox (Manager+) */}
      {canManage ? (
        <form
          onSubmit={onCreate}
          className="space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-card"
        >
          <h2 className="text-sm font-semibold text-neutral-900">Add a shared team inbox</h2>
          <p className="text-sm text-neutral-600">
            Register a team inbox (info@, admissions@, sales@…). It starts disconnected — connecting
            the provider comes in a later phase. Access is granted per agent below.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sharedAddress">Email address</Label>
              <Input
                id="sharedAddress"
                type="email"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="admissions@studymind.co.uk"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sharedName">Display name (optional)</Label>
              <Input
                id="sharedName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Admissions"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sharedProvider">Provider</Label>
              <Select id="sharedProvider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {providerList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.connectable ? '' : ' (coming soon)'}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sharedTeam">Owning team (optional)</Label>
              <Select id="sharedTeam" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">No team</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <Button type="submit" disabled={create.isPending || !address.trim()}>
            {create.isPending ? 'Adding…' : 'Add shared inbox'}
          </Button>
        </form>
      ) : null}

      {/* Accounts list */}
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-neutral-500">
            No mail accounts yet. Import your connected Gmail above to get started.
          </p>
        ) : (
          <ul>
            {rows.map((row) => {
              const isOwnPersonal = row.ownerKind === 'personal' && row.ownerUserId === meId
              const canManageRow = canManage || isOwnPersonal
              const isShared = row.ownerKind === 'shared'
              return (
                <li key={row.id} className="border-b border-neutral-100 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span
                      aria-hidden
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700"
                    >
                      {isShared ? <UsersIcon size={15} /> : <MailIcon size={15} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-neutral-900">
                          {row.displayName ?? row.address}
                        </span>
                        {row.isDefault ? (
                          <Badge tone="info" dot>
                            Default
                          </Badge>
                        ) : null}
                        <Badge tone={isShared ? 'accent' : 'neutral'}>
                          {isShared ? 'Shared' : 'Personal'}
                        </Badge>
                        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                      </div>
                      <div className="truncate text-xs text-neutral-500">
                        {row.providerLabel} · {row.address}
                        {isShared && row.teamName ? ` · ${row.teamName}` : ''}
                        {isShared ? ` · ${row.memberCount} member${row.memberCount === 1 ? '' : 's'}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {isOwnPersonal && !row.isDefault ? (
                        <Button type="button" size="xs" variant="ghost" onClick={() => onSetDefault(row.id)}>
                          <CheckCircleIcon size={14} /> Set default
                        </Button>
                      ) : null}
                      {isShared && canManage ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => setExpanded((cur) => (cur === row.id ? null : row.id))}
                        >
                          Members
                        </Button>
                      ) : null}
                      {canManageRow && row.provider === 'gmail' && row.gmailMailboxId ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={resync.isPending}
                          onClick={() => onResync(row.id)}
                          title="Re-read archived state + labels from Gmail"
                        >
                          Resync
                        </Button>
                      ) : null}
                      {canManageRow ? (
                        <Button type="button" size="xs" variant="ghost" onClick={() => onDisconnect(row.id)}>
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {isShared && canManage && expanded === row.id ? (
                    <SharedMembers accountId={row.id} />
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
