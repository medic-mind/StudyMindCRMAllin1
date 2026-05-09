'use client'

// Per-row role assign/revoke controls. Calls the audited admin.users
// mutations and refreshes the RSC tree.

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

const ROLES = ['admin', 'ops_manager', 'agent', 'finance', 'dsl', 'read_only'] as const
type RoleName = (typeof ROLES)[number]

export function UserRoleControls({
  userId,
  currentRoles,
}: {
  userId: string
  currentRoles: string[]
}) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const assign = trpc.admin.users.assignRole.useMutation({
    onSuccess: () => {
      setPending(null)
      router.refresh()
    },
    onError: (e) => {
      setPending(null)
      setError(e.message)
    },
  })
  const revoke = trpc.admin.users.revokeRole.useMutation({
    onSuccess: () => {
      setPending(null)
      router.refresh()
    },
    onError: (e) => {
      setPending(null)
      setError(e.message)
    },
  })

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {ROLES.map((role) => {
          const has = currentRoles.includes(role)
          const key = `${role}:${has ? 'rev' : 'asg'}`
          return (
            <Button
              key={role}
              type="button"
              variant={has ? 'secondary' : 'ghost'}
              disabled={pending === key}
              onClick={() => {
                setError(null)
                setPending(key)
                if (has) revoke.mutate({ userId, role: role as RoleName })
                else assign.mutate({ userId, role: role as RoleName })
              }}
              className="h-7 px-2 text-xs"
            >
              {has ? `− ${role}` : `+ ${role}`}
            </Button>
          )
        })}
      </div>
      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
