'use client'

import { toast } from 'sonner'

import { Button } from '@/components/ui/button'

import { trpc } from '@/lib/trpc/client'

function fmt(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const dt = typeof d === 'string' ? new Date(d) : d
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(dt)
}

export function SessionsList() {
  const { data, isLoading, refetch } = trpc.account.sessions.list.useQuery()
  const revoke = trpc.account.sessions.revoke.useMutation({
    onSuccess: () => {
      toast.success('Session signed out')
      refetch()
    },
    onError: (err) => toast.error(err.message ?? 'Could not revoke session'),
  })
  const revokeAll = trpc.account.sessions.revokeAllOthers.useMutation({
    onSuccess: ({ count }) => {
      toast.success(`Signed out ${count} other session${count === 1 ? '' : 's'}`)
      refetch()
    },
    onError: (err) => toast.error(err.message ?? 'Could not revoke other sessions'),
  })

  if (isLoading) {
    return <p className="text-sm text-neutral-500">Loading sessions…</p>
  }

  const items = data?.items ?? []
  if (items.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        No active sessions yet. Sign in on a device to populate this list.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => revokeAll.mutate()}
          disabled={revokeAll.isPending || items.length <= 1}
        >
          {revokeAll.isPending ? 'Signing out…' : 'Sign out all other sessions'}
        </Button>
      </div>
      <table className="w-full table-auto border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="py-2 pr-4">
              Device
            </th>
            <th scope="col" className="py-2 pr-4">
              IP
            </th>
            <th scope="col" className="py-2 pr-4">
              Started
            </th>
            <th scope="col" className="py-2 pr-4">
              Expires
            </th>
            <th scope="col" className="py-2 pr-4">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id} className="border-b border-neutral-100">
              <td className="py-2 pr-4 align-top">
                <div className="text-neutral-900">{s.userAgent ?? 'Unknown'}</div>
                {s.isCurrent && (
                  <div className="text-xs text-green-700">This session</div>
                )}
              </td>
              <td className="py-2 pr-4 align-top text-neutral-700">{s.ip ?? '—'}</td>
              <td className="py-2 pr-4 align-top text-neutral-700">{fmt(s.createdAt)}</td>
              <td className="py-2 pr-4 align-top text-neutral-700">{fmt(s.expiresAt)}</td>
              <td className="py-2 pr-4 align-top text-right">
                {!s.isCurrent && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revoke.mutate({ sessionId: s.id })}
                    disabled={revoke.isPending}
                  >
                    Sign out
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
