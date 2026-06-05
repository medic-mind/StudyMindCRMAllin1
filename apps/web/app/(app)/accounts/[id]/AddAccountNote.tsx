'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

export function AddAccountNote({ accountId }: { accountId: string }) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const add = trpc.businessAccount.notes.add.useMutation({
    onSuccess: () => {
      toast.success('Note added')
      setBody('')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not add note'),
  })

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!body.trim()) {
          toast.error('Write something first.')
          return
        }
        add.mutate({ accountId, body: body.trim() })
      }}
    >
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder="Add a note about this account — anything the next agent needs to know."
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={add.isPending}>
          {add.isPending ? 'Adding…' : 'Add note'}
        </Button>
      </div>
    </form>
  )
}
