'use client'

// Per-row user controls + the create/edit dialogs for Settings → Users.
// Buttons are filtered by the caller's capabilities (ADR 0021):
//   - create / resend-invite / deactivate : CEO + Senior Manager
//   - edit details / change email / reset password : CEO/SM/Manager or a
//     `user.manage` grant (and never against a CEO/Senior Manager unless you
//     are one)
//   - role grant/revoke : gated per-role by canGrantRole / canRevokeRole
//   - delegate the manage permission : CEO/SM/Manager
// The server re-checks every one of these — the UI only hides what it must.

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

export interface AccessFlags {
  role: Role
  canCreate: boolean
  canManage: boolean
  canGrantManage: boolean
  canDeactivate: boolean
  canManageRoles: boolean
}

const LEADERSHIP: ReadonlySet<string> = new Set(['ceo', 'senior_manager'])
const MANAGE_BY_ROLE: ReadonlySet<string> = new Set(['ceo', 'senior_manager', 'manager'])

/** Whether the actor may edit/reset a target with these roles (mirrors the server). */
function actorCanActOn(access: AccessFlags, targetRoles: string[]): boolean {
  if (access.role === 'ceo' || access.role === 'senior_manager') return true
  return !targetRoles.some((r) => LEADERSHIP.has(r))
}

/* -------------------------------------------------------------------------- */
/* credential reveal — shown after create / reset                              */
/* -------------------------------------------------------------------------- */

function CredentialReveal({
  email,
  temporaryPassword,
}: {
  email: string
  temporaryPassword: string
}) {
  const copy = (value: string, label: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => toast.success(`${label} copied`),
      () => toast.error('Could not copy'),
    )
  }
  return (
    <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm">
      <p className="mb-2 font-medium text-green-900">
        Account ready. A welcome email with these details (and a PDF) has been sent.
      </p>
      <p className="mb-2 text-green-900">
        Share the temporary password securely if the email does not arrive — it must be changed on
        first sign-in.
      </p>
      <dl className="space-y-1">
        <div className="flex items-center gap-2">
          <dt className="w-40 text-green-800">Email / username</dt>
          <dd className="font-mono text-xs">{email}</dd>
          <button
            type="button"
            className="text-xs text-green-800 underline"
            onClick={() => copy(email, 'Email')}
          >
            copy
          </button>
        </div>
        <div className="flex items-center gap-2">
          <dt className="w-40 text-green-800">Temporary password</dt>
          <dd className="font-mono text-sm font-semibold">{temporaryPassword}</dd>
          <button
            type="button"
            className="text-xs text-green-800 underline"
            onClick={() => copy(temporaryPassword, 'Password')}
          >
            copy
          </button>
        </div>
      </dl>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* create user dialog (temp password + welcome PDF)                            */
/* -------------------------------------------------------------------------- */

export function CreateUserDialog({ access }: { access: AccessFlags }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [roles, setRoles] = useState<Role[]>([])
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string } | null>(null)

  const grantable = ROLES.filter((r) => canGrantRole(access.role, r))

  const create = trpc.admin.users.create.useMutation({
    onSuccess: (res) => {
      setCreated({ email: res.email, temporaryPassword: res.temporaryPassword })
      toast.success('Account created')
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not create the account')
    },
  })

  const close = () => {
    setOpen(false)
    setEmail('')
    setName('')
    setRoles([])
    setError(null)
    setCreated(null)
  }

  if (!access.canCreate) return null

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        Add user
      </Button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-md border border-neutral-200 bg-white p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{created ? 'Account created' : 'Create a user'}</h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-neutral-500 hover:text-neutral-900"
          >
            ×
          </button>
        </div>

        {created ? (
          <div className="space-y-4">
            <CredentialReveal email={created.email} temporaryPassword={created.temporaryPassword} />
            <div className="flex justify-end">
              <Button type="button" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setError(null)
              if (!email || roles.length === 0) {
                setError('Email and at least one role are required.')
                return
              }
              create.mutate({ email, name: name || undefined, roles })
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
            <p className="text-xs text-neutral-600">
              The new user receives a welcome email with a temporary password (and a PDF) and must
              set their own password on first sign-in.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="create-email">Email</Label>
              <Input
                id="create-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-name">Name (optional)</Label>
              <Input id="create-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Roles</Label>
              <div className="flex flex-wrap gap-2">
                {grantable.map((r) => (
                  <label key={r} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={roles.includes(r)}
                      onChange={(e) =>
                        setRoles((prev) =>
                          e.target.checked ? [...prev, r] : prev.filter((x) => x !== r),
                        )
                      }
                    />
                    {formatRoleLabel(r)}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create user'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* edit user dialog (name + email)                                             */
/* -------------------------------------------------------------------------- */

function EditUserDialog({
  userId,
  currentName,
  currentEmail,
  onClose,
}: {
  userId: string
  currentName: string | null
  currentEmail: string
  onClose: () => void
}) {
  const router = useRouter()
  const [name, setName] = useState(currentName ?? '')
  const [email, setEmail] = useState(currentEmail)
  const [error, setError] = useState<string | null>(null)

  const update = trpc.admin.users.update.useMutation({
    onSuccess: () => {
      toast.success('User updated')
      router.refresh()
      onClose()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not update the user')
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-md border border-neutral-200 bg-white p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Edit user</h2>
          <button
            type="button"
            onClick={onClose}
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
            const trimmedName = name.trim()
            const trimmedEmail = email.trim().toLowerCase()
            update.mutate({
              userId,
              name: trimmedName ? trimmedName : undefined,
              email: trimmedEmail !== currentEmail.toLowerCase() ? trimmedEmail : undefined,
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
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-email">Email</Label>
            <Input
              id="edit-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <p className="text-xs text-neutral-500">
              Changing the email also changes the address used to sign in.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* per-row controls                                                            */
/* -------------------------------------------------------------------------- */

export interface UserRowControlsProps {
  userId: string
  email: string
  name: string | null
  currentRoles: string[]
  extraPermissions: string[]
  status: UserStatus
  isSelf: boolean
  access: AccessFlags
}

export function UserRowControls({
  userId,
  email,
  name,
  currentRoles,
  extraPermissions,
  status,
  isSelf,
  access,
}: UserRowControlsProps) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [resetResult, setResetResult] = useState<{ email: string; temporaryPassword: string } | null>(
    null,
  )

  const canActOnTarget = actorCanActOn(access, currentRoles)
  const hasManageGrant = extraPermissions.includes('user.manage')
  const targetManagesByRole = currentRoles.some((r) => MANAGE_BY_ROLE.has(r))

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

  const assign = trpc.admin.users.assignRole.useMutation({ onSuccess: ok('Role granted'), onError: onErr })
  const revoke = trpc.admin.users.revokeRole.useMutation({ onSuccess: ok('Role revoked'), onError: onErr })
  const resend = trpc.admin.users.resendInvite.useMutation({ onSuccess: ok('Invite resent'), onError: onErr })
  const cancel = trpc.admin.users.cancelInvite.useMutation({ onSuccess: ok('Invite cancelled'), onError: onErr })
  const deactivate = trpc.admin.users.deactivate.useMutation({ onSuccess: ok('User deactivated'), onError: onErr })
  const reactivate = trpc.admin.users.reactivate.useMutation({ onSuccess: ok('User reactivated'), onError: onErr })
  const grantPerm = trpc.admin.users.grantPermission.useMutation({ onSuccess: ok('Permission granted'), onError: onErr })
  const revokePerm = trpc.admin.users.revokePermission.useMutation({ onSuccess: ok('Permission revoked'), onError: onErr })
  const resetPassword = trpc.admin.users.resetPassword.useMutation({
    onSuccess: (res) => {
      setPending(null)
      setError(null)
      setResetResult({ email: res.email, temporaryPassword: res.temporaryPassword })
      toast.success('Password reset')
      router.refresh()
    },
    onError: onErr,
  })

  return (
    <div className="space-y-1">
      {/* role grant / revoke — only for CEO + Senior Manager */}
      {access.canManageRoles && (
        <div className="flex flex-wrap gap-1">
          {ROLES.map((role) => {
            const has = currentRoles.includes(role)
            const canAct = has ? canRevokeRole(access.role, role) : canGrantRole(access.role, role)
            if (!canAct) return null
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
      )}

      <div className="flex flex-wrap gap-1">
        {/* edit + reset password — manage capability, and not against leadership */}
        {access.canManage && canActOnTarget && status !== 'deactivated' && (
          <Button
            type="button"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => setEditing(true)}
          >
            edit
          </Button>
        )}
        {access.canManage &&
          canActOnTarget &&
          (status === 'active' || status === 'locked') && (
            <Button
              type="button"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={pending === 'reset' || resetPassword.isPending}
              onClick={() => {
                if (
                  !window.confirm(
                    'Reset this user’s password? A new temporary password will be issued and emailed, and their current sessions will end.',
                  )
                )
                  return
                setError(null)
                setPending('reset')
                resetPassword.mutate({ userId })
              }}
            >
              reset password
            </Button>
          )}

        {/* delegate the user.manage permission to an individual */}
        {access.canGrantManage && canActOnTarget && !targetManagesByRole && (
          <Button
            type="button"
            variant={hasManageGrant ? 'secondary' : 'ghost'}
            className="h-7 px-2 text-xs"
            disabled={pending === 'perm'}
            onClick={() => {
              setError(null)
              setPending('perm')
              if (hasManageGrant) revokePerm.mutate({ userId, permission: 'user.manage' })
              else grantPerm.mutate({ userId, permission: 'user.manage' })
            }}
          >
            {hasManageGrant ? '− user manager' : '+ user manager'}
          </Button>
        )}

        {/* pending-invite actions — CEO + Senior Manager */}
        {access.canCreate && status === 'invited' && (
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

        {/* deactivate / reactivate — CEO + Senior Manager */}
        {access.canDeactivate && (status === 'active' || status === 'locked') && !isSelf && (
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
        {access.canDeactivate && status === 'deactivated' && (
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

      {resetResult && (
        <CredentialReveal
          email={resetResult.email}
          temporaryPassword={resetResult.temporaryPassword}
        />
      )}

      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {editing && (
        <EditUserDialog
          userId={userId}
          currentName={name}
          currentEmail={email}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}
