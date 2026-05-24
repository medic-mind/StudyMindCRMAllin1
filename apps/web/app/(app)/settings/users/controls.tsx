'use client'

// Per-row role assign/revoke controls and the invite dialog. Action buttons
// are filtered by what the current actor's role permits via canGrantRole /
// canRevokeRole. CLAUDE.md §20.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import {
  ROLES,
  canGrantRole,
  canRevokeRole,
  type Role,
} from '@studymind/core/auth/policies'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatRoleLabel } from '@/lib/format/role-label'
import { trpc } from '@/lib/trpc/client'

type UserStatus = 'active' | 'invited' | 'deactivated' | 'locked'

interface UserRoleControlsProps {
  userId: string
  currentRoles: string[]
  status: UserStatus
  actorRole: Role
  isSelf: boolean
}

export function UserRoleControls({
  userId,
  currentRoles,
  status,
  actorRole,
  isSelf,
}: UserRoleControlsProps) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ok = (msg: string) => () => {
    setPending(null)
    setError(null)
    toast.success(msg)
    router.refresh()
  }
  const onErr = (e: { message: string }) => {
    setPending(null)
    setError(e.message)
    toast.error(e.message ?? 'Action failed')
  }

  const assign = trpc.admin.users.assignRole.useMutation({
    onSuccess: ok('Role granted'),
    onError: onErr,
  })
  const revoke = trpc.admin.users.revokeRole.useMutation({
    onSuccess: ok('Role revoked'),
    onError: onErr,
  })
  const resend = trpc.admin.users.resendInvite.useMutation({
    onSuccess: ok('Invite resent'),
    onError: onErr,
  })
  const cancel = trpc.admin.users.cancelInvite.useMutation({
    onSuccess: ok('Invite cancelled'),
    onError: onErr,
  })
  const deactivate = trpc.admin.users.deactivate.useMutation({
    onSuccess: ok('User deactivated'),
    onError: onErr,
  })
  const reactivate = trpc.admin.users.reactivate.useMutation({
    onSuccess: ok('User reactivated'),
    onError: onErr,
  })

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {ROLES.map((role) => {
          const has = currentRoles.includes(role)
          const canAct = has ? canRevokeRole(actorRole, role) : canGrantRole(actorRole, role)
          if (!canAct) return null
          // Self-demotion guard mirrors the server (ADR 0014).
          if (isSelf && has && (role === 'ceo' || role === 'senior_manager')) return null
          const key = `${role}:${has ? 'rev' : 'asg'}`
          return (
            <Button
              key={role}
              type="button"
              variant={has ? 'secondary' : 'ghost'}
              disabled={pending === key || status === 'deactivated'}
              onClick={() => {
                setError(null)
                setPending(key)
                if (has) revoke.mutate({ userId, role })
                else assign.mutate({ userId, role })
              }}
              className="h-7 px-2 text-xs"
            >
              {has ? `− ${formatRoleLabel(role)}` : `+ ${formatRoleLabel(role)}`}
            </Button>
          )
        })}
      </div>

      <div className="flex flex-wrap gap-1">
        {status === 'invited' && (
          <>
            <Button
              type="button"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={pending === 'resend'}
              onClick={() => {
                setError(null)
                setPending('resend')
                resend.mutate({ userId })
              }}
            >
              resend invite
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-7 px-2 text-xs text-red-700"
              disabled={pending === 'cancel'}
              onClick={() => {
                setError(null)
                setPending('cancel')
                cancel.mutate({ userId })
              }}
            >
              cancel invite
            </Button>
          </>
        )}
        {(status === 'active' || status === 'locked') && !isSelf && (
          <Button
            type="button"
            variant="ghost"
            className="h-7 px-2 text-xs text-red-700"
            disabled={pending === 'deact'}
            onClick={() => {
              const reason = window.prompt('Reason for deactivation?')
              if (!reason) return
              setError(null)
              setPending('deact')
              deactivate.mutate({ userId, reason })
            }}
          >
            deactivate
          </Button>
        )}
        {status === 'deactivated' && (
          <Button
            type="button"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={pending === 'react'}
            onClick={() => {
              setError(null)
              setPending('react')
              reactivate.mutate({ userId })
            }}
          >
            reactivate
          </Button>
        )}
      </div>

      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* invite dialog                                                               */
/* -------------------------------------------------------------------------- */

export function InviteDialog({ actorRole }: { actorRole: Role }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [roles, setRoles] = useState<Role[]>([])
  const [error, setError] = useState<string | null>(null)

  const grantable = ROLES.filter((r) => canGrantRole(actorRole, r))

  const invite = trpc.admin.users.invite.useMutation({
    onSuccess: () => {
      setOpen(false)
      setEmail('')
      setName('')
      setRoles([])
      toast.success('Invite sent')
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not send invite')
    },
  })

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        Invite user
      </Button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-md border border-neutral-200 bg-white p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Invite a user</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="text-neutral-500 hover:text-neutral-900"
          >
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            if (!email || roles.length === 0) {
              setError('Email and at least one role are required.')
              return
            }
            invite.mutate({
              email,
              name: name || undefined,
              roles,
            })
          }}
          className="space-y-3"
        >
          {error && (
            <div
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              role="alert"
            >
              {error}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-name">Name (optional)</Label>
            <Input
              id="invite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Roles</Label>
            <div className="flex flex-wrap gap-2">
              {grantable.map((r) => {
                const checked = roles.includes(r)
                return (
                  <label key={r} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setRoles((prev) =>
                          e.target.checked
                            ? [...prev, r]
                            : prev.filter((x) => x !== r),
                        )
                      }
                    />
                    {formatRoleLabel(r)}
                  </label>
                )
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? 'Sending…' : 'Send invite'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
