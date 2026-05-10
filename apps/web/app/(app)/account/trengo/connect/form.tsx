// Trengo connect form. Client island. CLAUDE.md §11.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

export function TrengoConnectForm() {
  const router = useRouter()
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ expiresAt: Date; email: string | null } | null>(null)

  const connect = trpc.account.trengo.connect.useMutation({
    onSuccess: (out) => {
      setSuccess({ expiresAt: out.expiresAt, email: out.trengoEmail })
      setError(null)
      setToken('')
      toast.success('Trengo connected')
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not connect Trengo')
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (token.trim().length < 8) {
      setError('That does not look like a Trengo token — paste the full string.')
      return
    }
    setError(null)
    connect.mutate({ token: token.trim() })
  }

  if (success) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-900">
        <p className="font-medium">Connected.</p>
        <p className="mt-1">
          Token valid until{' '}
          {new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'medium',
          }).format(success.expiresAt)}
          {success.email ? <> for <strong>{success.email}</strong></> : null}.
        </p>
        <p className="mt-2 text-xs text-green-800">
          You will see a banner in 14 days asking you to rotate.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" aria-label="Connect Trengo token">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-neutral-700">Trengo personal API token</span>
        <input
          type="password"
          required
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste token here"
          className="rounded border border-neutral-300 bg-white px-2 py-1 font-mono"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={connect.isPending}>
        {connect.isPending ? 'Validating…' : 'Connect'}
      </Button>
    </form>
  )
}
