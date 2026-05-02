'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { trpc } from '@/lib/trpc/client'

export function AddNote({ contactId }: { contactId: string }) {
  const router = useRouter()
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const create = trpc.interaction.create.useMutation({
    onSuccess: () => {
      toast.success('Note added')
      setSummary('')
      setBody('')
      router.refresh()
    },
    onError: (err) => toast.error(err.message ?? 'Could not add note'),
  })

  return (
    <form
      className="space-y-3 rounded-md border border-neutral-200 bg-white p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!summary.trim() || !body.trim()) {
          toast.error('Summary and body are both required')
          return
        }
        create.mutate({
          type: 'note',
          contactId,
          summary: summary.trim(),
          body: body.trim(),
        })
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="note-summary">Summary</Label>
        <Input
          id="note-summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="One line — what is this note about?"
          maxLength={500}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="note-body">Note</Label>
        <Textarea
          id="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Anything the next agent needs to know."
          rows={4}
          maxLength={5000}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add note'}
        </Button>
      </div>
    </form>
  )
}
