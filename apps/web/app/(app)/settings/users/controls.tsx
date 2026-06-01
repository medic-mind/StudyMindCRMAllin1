'use client'

// Settings → Users: create dialog + per-row actions. ADR 0021.
//
// UI niceties (no new deps — hand-rolled menu mirroring MoveCardMenu, shared
// modal shell, on-brand confirm dialogs):
//   - a per-row "⋯" actions menu instead of a cluster of inline buttons
//   - proper in-app confirm dialogs (deactivate reason, reset password) rather
//     than window.prompt/confirm
//   - a credentials modal with "copy all login details" + email-status note
//   - a roles editor dialog instead of +/- toggle soup
//
// Buttons/menu items are filtered by the caller's capabilities; the server
// re-checks every one.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
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
import { PasswordField } from '@/components/ui/password-field'
import { Textarea } from '@/components/ui/textarea'
import { formatRoleLabel } from '@/lib/format/role-label'
import { trpc } from '@/lib/trpc/client'

export type UserStatus = 'active' | 'invited' | 'deactivated' | 'locked'
export type EmailStatus = 'sent' | 'skipped' | 'failed'

export interface AccessFlags {
  role: Role
  canCreate: boolean
  canManage: boolean
  canGrantManage: boolean
  canDeactivate: boolean
  canManageRoles: boolean
  systemEmailReady?: boolean
}

const LEADERSHIP = new Set(['ceo', 'senior_manager'])
const MANAGE_BY_ROLE = new Set(['ceo', 'senior_manager', 'manager'])

function actorCanActOn(access: AccessFlags, targetRoles: string[]): boolean {
  if (access.role === 'ceo' || access.role === 'senior_manager') return true
  return !targetRoles.some((r) => LEADERSHIP.has(r))
}

async function copy(value: string, label: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value)
    toast.success(`${label} copied`)
  } catch {
    toast.error('Could not copy')
  }
}

/* -------------------------------------------------------------------------- */
/* shared modal shell                                                          */
/* -------------------------------------------------------------------------- */

function ModalShell({
  title,
  onClose,
  children,
  width = 'max-w-md',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${width} rounded-lg border border-neutral-200 bg-white p-4 shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-500 hover:text-neutral-900"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* credential reveal                                                           */
/* -------------------------------------------------------------------------- */

function CredentialReveal({
  email,
  temporaryPassword,
  emailStatus,
}: {
  email: string
  temporaryPassword: string
  emailStatus?: EmailStatus
}) {
  const signInUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/sign-in` : '/sign-in'
  const all =
    `StudyMind CRM login\n` +
    `Sign in: ${signInUrl}\n` +
    `Email: ${email}\n` +
    `Temporary password: ${temporaryPassword}\n` +
    `You'll be asked to set your own password on first sign-in.`

  const note =
    emailStatus === 'sent'
      ? { tone: 'text-green-800', text: `A welcome email with these details (and a PDF) was sent to ${email}.` }
      : emailStatus === 'failed'
        ? { tone: 'text-amber-800', text: `We couldn't send the email — copy these details and share them securely.` }
        : { tone: 'text-amber-800', text: `Email isn't connected yet, so nothing was sent — copy these details and share them securely.` }

  const Row = ({ label, value, mono }: { label: string; value: string; mono?: boolean }) => (
    <div className="flex items-center gap-2">
      <span className="w-40 shrink-0 text-neutral-500">{label}</span>
      <span className={`flex-1 break-all ${mono ? 'font-mono text-sm font-semibold' : 'text-sm'}`}>
        {value}
      </span>
      <button type="button" className="text-xs text-primary-700 underline" onClick={() => void copy(value, label)}>
        copy
      </button>
    </div>
  )

  return (
    <div className="space-y-3">
      <p className={`text-sm ${note.tone}`}>{note.text}</p>
      <div className="space-y-1.5 rounded-md border border-neutral-200 bg-neutral-50 p-3">
        <Row label="Email / username" value={email} />
        <Row label="Temporary password" value={temporaryPassword} mono />
        <Row label="Sign-in address" value={signInUrl} />
      </div>
      <Button type="button" className="w-full" onClick={() => void copy(all, 'Login details')}>
        Copy all login details
      </Button>
      <p className="text-xs text-neutral-500">
        Keep these details private and share them over a channel you trust.
      </p>
    </div>
  )
}

function CredentialModal(props: {
  title: string
  email: string
  temporaryPassword: string
  emailStatus?: EmailStatus
  onClose: () => void
}) {
  return (
    <ModalShell title={props.title} onClose={props.onClose}>
      <CredentialReveal
        email={props.email}
        temporaryPassword={props.temporaryPassword}
        emailStatus={props.emailStatus}
      />
      <div className="mt-4 flex justify-end">
        <Button type="button" onClick={props.onClose}>
          Done
        </Button>
      </div>
    </ModalShell>
  )
}

/* -------------------------------------------------------------------------- */
/* confirm dialog (optional reason)                                            */
/* -------------------------------------------------------------------------- */

function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  reason,
  pending,
  onConfirm,
  onClose,
}: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  reason?: { label: string; placeholder?: string }
  pending?: boolean
  onConfirm: (reason: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState('')
  const disabled = pending || (reason ? value.trim().length === 0 : false)
  return (
    <ModalShell title={title} onClose={onClose}>
      <p className="text-sm text-neutral-700">{body}</p>
      {reason && (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="confirm-reason">{reason.label}</Label>
          <Textarea
            id="confirm-reason"
            value={value}
            placeholder={reason.placeholder}
            onChange={(e) => setValue(e.target.value)}
            rows={3}
          />
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={danger ? 'destructive' : 'default'}
          disabled={disabled}
          onClick={() => onConfirm(value.trim())}
        >
          {pending ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </ModalShell>
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
  const [mode, setMode] = useState<'generate' | 'manual'>('generate')
  const [password, setPassword] = useState('')
  const [requireChange, setRequireChange] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{
    email: string
    temporaryPassword: string
    emailStatus: EmailStatus
  } | null>(null)

  const grantable = ROLES.filter((r) => canGrantRole(access.role, r))

  const create = trpc.admin.users.create.useMutation({
    onSuccess: (res) => {
      setCreated({
        email: res.email,
        temporaryPassword: res.temporaryPassword,
        emailStatus: res.emailStatus,
      })
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
    setMode('generate')
    setPassword('')
    setRequireChange(true)
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
    <ModalShell title={created ? 'Account created' : 'Create a user'} onClose={close}>
      {created ? (
        <div className="space-y-4">
          <CredentialReveal
            email={created.email}
            temporaryPassword={created.temporaryPassword}
            emailStatus={created.emailStatus}
          />
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
            if (mode === 'manual' && password.trim().length === 0) {
              setError('Enter a password, or switch to “Generate a temporary password”.')
              return
            }
            create.mutate({
              email,
              name: name || undefined,
              roles,
              password: mode === 'manual' ? password : undefined,
              requireChange,
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

          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-neutral-800">Password</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="create-mode"
                className="mt-0.5"
                checked={mode === 'generate'}
                onChange={() => setMode('generate')}
              />
              <span>
                <span className="font-medium">Generate a temporary password</span>
                <span className="block text-xs text-neutral-500">
                  Random, emailed with a PDF when Gmail is connected.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="create-mode"
                className="mt-0.5"
                checked={mode === 'manual'}
                onChange={() => setMode('manual')}
              />
              <span>
                <span className="font-medium">Set a password myself</span>
                <span className="block text-xs text-neutral-500">
                  Useful if they can&rsquo;t receive email — share it with them directly.
                </span>
              </span>
            </label>
          </fieldset>

          {mode === 'manual' && (
            <div className="space-y-1.5">
              <Label htmlFor="create-password">Password</Label>
              <PasswordField
                id="create-password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-neutral-500">
                At least 12 characters, with 3 of: lowercase, uppercase, number, symbol.
              </p>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requireChange}
              onChange={(e) => setRequireChange(e.target.checked)}
            />
            Require a password change on first sign-in
          </label>

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
    </ModalShell>
  )
}

/* -------------------------------------------------------------------------- */
/* edit user (name + email)                                                    */
/* -------------------------------------------------------------------------- */

function EditUserModal({
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
    <ModalShell title="Edit user" onClose={onClose}>
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
    </ModalShell>
  )
}

/* -------------------------------------------------------------------------- */
/* roles editor                                                                */
/* -------------------------------------------------------------------------- */

function RolesModal({
  userId,
  currentRoles,
  access,
  isSelf,
  onClose,
}: {
  userId: string
  currentRoles: string[]
  access: AccessFlags
  isSelf: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const refresh = () => router.refresh()
  const assign = trpc.admin.users.assignRole.useMutation({
    onSuccess: () => {
      setPending(null)
      toast.success('Role granted')
      refresh()
    },
    onError: (e) => {
      setPending(null)
      toast.error(e.message ?? 'Failed')
    },
  })
  const revoke = trpc.admin.users.revokeRole.useMutation({
    onSuccess: () => {
      setPending(null)
      toast.success('Role revoked')
      refresh()
    },
    onError: (e) => {
      setPending(null)
      toast.error(e.message ?? 'Failed')
    },
  })

  return (
    <ModalShell title="Manage roles" onClose={onClose}>
      <div className="space-y-2">
        {ROLES.map((role) => {
          const has = currentRoles.includes(role)
          const canAct = has ? canRevokeRole(access.role, role) : canGrantRole(access.role, role)
          const selfLock = isSelf && has && (role === 'ceo' || role === 'senior_manager')
          return (
            <label
              key={role}
              className={`flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-sm ${
                canAct && !selfLock ? '' : 'opacity-60'
              }`}
            >
              <span>{formatRoleLabel(role)}</span>
              <input
                type="checkbox"
                checked={has}
                disabled={!canAct || selfLock || pending !== null}
                onChange={() => {
                  setPending(role)
                  if (has) revoke.mutate({ userId, role })
                  else assign.mutate({ userId, role })
                }}
              />
            </label>
          )
        })}
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        You can only grant or revoke roles at or below your own level.
      </p>
      <div className="mt-4 flex justify-end">
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </div>
    </ModalShell>
  )
}

/* -------------------------------------------------------------------------- */
/* reset password — generate a temporary one, or set one manually              */
/* -------------------------------------------------------------------------- */

function ResetPasswordModal({
  userId,
  email,
  onClose,
  onReset,
}: {
  userId: string
  email: string
  onClose: () => void
  onReset: (res: { temporaryPassword: string; emailStatus: EmailStatus }) => void
}) {
  const router = useRouter()
  const [mode, setMode] = useState<'generate' | 'manual'>('generate')
  const [password, setPassword] = useState('')
  const [requireChange, setRequireChange] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reset = trpc.admin.users.resetPassword.useMutation({
    onSuccess: (res) => {
      router.refresh()
      onReset({ temporaryPassword: res.temporaryPassword, emailStatus: res.emailStatus })
    },
    onError: (e) => setError(e.message),
  })

  const disabled = reset.isPending || (mode === 'manual' && password.trim().length === 0)

  return (
    <ModalShell title="Reset password" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          reset.mutate({
            userId,
            password: mode === 'manual' ? password : undefined,
            requireChange,
          })
        }}
      >
        {error && (
          <div
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            role="alert"
          >
            {error}
          </div>
        )}
        <p className="text-sm text-neutral-700">
          Issue a new password for <span className="font-medium">{email}</span>. Their current
          sessions end immediately.
        </p>

        <fieldset className="space-y-2">
          <legend className="sr-only">Password method</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="reset-mode"
              className="mt-0.5"
              checked={mode === 'generate'}
              onChange={() => setMode('generate')}
            />
            <span>
              <span className="font-medium">Generate a temporary password</span>
              <span className="block text-xs text-neutral-500">
                Random, emailed with a PDF when Gmail is connected.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="reset-mode"
              className="mt-0.5"
              checked={mode === 'manual'}
              onChange={() => setMode('manual')}
            />
            <span>
              <span className="font-medium">Set a password myself</span>
              <span className="block text-xs text-neutral-500">
                Useful if they&rsquo;ve lost access to their email — share it with them directly.
              </span>
            </span>
          </label>
        </fieldset>

        {mode === 'manual' && (
          <div className="space-y-1.5">
            <Label htmlFor="reset-password">New password</Label>
            <PasswordField
              id="reset-password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-neutral-500">
              At least 12 characters, with 3 of: lowercase, uppercase, number, symbol.
            </p>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={requireChange}
            onChange={(e) => setRequireChange(e.target.checked)}
          />
          Require a password change on first sign-in
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={disabled}>
            {reset.isPending ? 'Resetting…' : 'Reset password'}
          </Button>
        </div>
      </form>
    </ModalShell>
  )
}

/* -------------------------------------------------------------------------- */
/* per-row "⋯" actions menu                                                    */
/* -------------------------------------------------------------------------- */

export interface RowActionsProps {
  userId: string
  email: string
  name: string | null
  currentRoles: string[]
  extraPermissions: string[]
  status: UserStatus
  isSelf: boolean
  access: AccessFlags
}

type DialogKind = 'edit' | 'roles' | 'reset' | 'deactivate' | 'cancelInvite' | null

export function RowActions(props: RowActionsProps) {
  const { userId, email, name, currentRoles, extraPermissions, status, isSelf, access } = props
  const router = useRouter()
  const [open, setOpen] = useState(false)
  // The menu is rendered position:fixed (anchored to the trigger) so it is not
  // clipped by the table's overflow-auto/rounded container. ADR 0021.
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [reveal, setReveal] = useState<{ temporaryPassword: string; emailStatus: EmailStatus } | null>(
    null,
  )
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    // A fixed-position menu detaches from the trigger when the page scrolls or
    // resizes, so close it on those.
    function close() {
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  function toggleMenu() {
    setOpen((v) => {
      const next = !v
      if (next && triggerRef.current) {
        const r = triggerRef.current.getBoundingClientRect()
        setMenuPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
      }
      return next
    })
  }

  const ok = (msg: string) => () => {
    toast.success(msg)
    router.refresh()
  }
  const onErr = (e: { message: string }) => toast.error(e.message ?? 'Action failed')

  const resend = trpc.admin.users.resendInvite.useMutation({ onSuccess: ok('Invite resent'), onError: onErr })
  const cancelInvite = trpc.admin.users.cancelInvite.useMutation({
    onSuccess: () => {
      setDialog(null)
      ok('Invite cancelled')()
    },
    onError: onErr,
  })
  const reactivate = trpc.admin.users.reactivate.useMutation({ onSuccess: ok('User reactivated'), onError: onErr })
  const grantPerm = trpc.admin.users.grantPermission.useMutation({ onSuccess: ok('Marked as user manager'), onError: onErr })
  const revokePerm = trpc.admin.users.revokePermission.useMutation({ onSuccess: ok('Removed user manager'), onError: onErr })
  const deactivate = trpc.admin.users.deactivate.useMutation({
    onSuccess: () => {
      setDialog(null)
      ok('User deactivated')()
    },
    onError: onErr,
  })

  const canAct = actorCanActOn(access, currentRoles)
  const hasManageGrant = extraPermissions.includes('user.manage')
  const targetManagesByRole = currentRoles.some((r) => MANAGE_BY_ROLE.has(r))

  // Build the menu item list from capabilities.
  const items: Array<{ key: string; label: string; danger?: boolean; run: () => void }> = []
  if (access.canManage && canAct && status !== 'deactivated') {
    items.push({ key: 'edit', label: 'Edit details', run: () => setDialog('edit') })
  }
  if (access.canManage && canAct && (status === 'active' || status === 'locked')) {
    items.push({ key: 'reset', label: 'Reset password', run: () => setDialog('reset') })
  }
  if (access.canManageRoles) {
    items.push({ key: 'roles', label: 'Manage roles', run: () => setDialog('roles') })
  }
  if (access.canGrantManage && canAct && !targetManagesByRole) {
    items.push({
      key: 'perm',
      label: hasManageGrant ? 'Remove user-manager' : 'Make user-manager',
      run: () => {
        setOpen(false)
        if (hasManageGrant) revokePerm.mutate({ userId, permission: 'user.manage' })
        else grantPerm.mutate({ userId, permission: 'user.manage' })
      },
    })
  }
  if (access.canCreate && status === 'invited') {
    items.push({ key: 'resend', label: 'Resend invite', run: () => { setOpen(false); resend.mutate({ userId }) } })
    items.push({ key: 'cancel', label: 'Cancel invite', danger: true, run: () => setDialog('cancelInvite') })
  }
  if (access.canDeactivate && (status === 'active' || status === 'locked') && !isSelf) {
    items.push({ key: 'deact', label: 'Deactivate', danger: true, run: () => setDialog('deactivate') })
  }
  if (access.canDeactivate && status === 'deactivated') {
    items.push({ key: 'react', label: 'Reactivate', run: () => { setOpen(false); reactivate.mutate({ userId }) } })
  }

  return (
    <div className="relative flex justify-end">
      {items.length === 0 ? (
        <span className="text-xs text-neutral-400">—</span>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="User actions"
          onClick={toggleMenu}
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-neutral-200 text-neutral-600 hover:bg-neutral-50"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      )}

      {open && menuPos && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="User actions"
          style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}
          className="z-50 w-48 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                it.run()
              }}
              className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-50 ${
                it.danger ? 'text-red-700' : 'text-neutral-800'
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}

      {dialog === 'edit' && (
        <EditUserModal
          userId={userId}
          currentName={name}
          currentEmail={email}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'roles' && (
        <RolesModal
          userId={userId}
          currentRoles={currentRoles}
          access={access}
          isSelf={isSelf}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'reset' && (
        <ResetPasswordModal
          userId={userId}
          email={email}
          onClose={() => setDialog(null)}
          onReset={(res) => {
            setDialog(null)
            setReveal(res)
            toast.success('Password reset')
          }}
        />
      )}
      {dialog === 'deactivate' && (
        <ConfirmModal
          title="Deactivate user"
          body={`Deactivate ${email}? They will be signed out and lose access until reactivated.`}
          confirmLabel="Deactivate"
          danger
          reason={{ label: 'Reason', placeholder: 'e.g. left the company' }}
          pending={deactivate.isPending}
          onConfirm={(reason) => deactivate.mutate({ userId, reason })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'cancelInvite' && (
        <ConfirmModal
          title="Cancel invite"
          body={`Cancel the pending invite for ${email}? The invite link will stop working.`}
          confirmLabel="Cancel invite"
          danger
          pending={cancelInvite.isPending}
          onConfirm={() => cancelInvite.mutate({ userId })}
          onClose={() => setDialog(null)}
        />
      )}

      {reveal && (
        <CredentialModal
          title="New password set"
          email={email}
          temporaryPassword={reveal.temporaryPassword}
          emailStatus={reveal.emailStatus}
          onClose={() => setReveal(null)}
        />
      )}
    </div>
  )
}
