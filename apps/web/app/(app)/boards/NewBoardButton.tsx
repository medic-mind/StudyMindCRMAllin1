// Create-board dialog trigger. ADR 0018. CEO + Senior Manager (the parent
// RSC only renders this for those roles; the server also gates board.create).

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

export function NewBoardButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const create = trpc.board.create.useMutation({
    onSuccess: (board) => {
      toast.success(`Board “${board.name}” created`)
      setOpen(false)
      setName('')
      setDescription('')
      router.push(`/boards/${board.id}`)
    },
    onError: (e) => toast.error(e.message ?? 'Could not create board'),
  })

  return (
    <div className="relative inline-block text-left">
      <Button size="sm" onClick={() => setOpen((o) => !o)}>
        New board
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Create board"
          className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-neutral-200 bg-white p-4 text-left shadow-lg"
        >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) {
            toast.error('Board name is required')
            return
          }
          create.mutate({
            name: name.trim(),
            description: description.trim() || undefined,
            isDefault: false,
          })
        }}
        className="flex flex-col gap-3"
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-neutral-700">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-neutral-700">Description</span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
          </div>
        </form>
        </div>
      ) : null}
    </div>
  )
}
