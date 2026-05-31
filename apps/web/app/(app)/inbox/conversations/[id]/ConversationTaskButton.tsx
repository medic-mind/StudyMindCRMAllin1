'use client'

// One-click CRM task from a conversation (ADR 0021 Phase 6). Reuses
// `task.create` — links the task to the conversation's contact when matched and
// defaults the assignee to the current agent. CLAUDE.md §26.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

interface Props {
  contactId: string | null
  meId: string
  defaultTitle: string
}

export function ConversationTaskButton({ contactId, meId, defaultTitle }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(defaultTitle)
  const [assigneeId, setAssigneeId] = useState(meId)
  const users = trpc.task.assignableUsers.useQuery({}, { enabled: open })
  const create = trpc.task.create.useMutation()

  async function submit() {
    const trimmed = title.trim()
    if (!trimmed || !assigneeId) return
    try {
      await create.mutateAsync({
        title: trimmed,
        assigneeId,
        ...(contactId ? { contactId } : {}),
      })
      toast.success('Task created')
      setOpen(false)
      setTitle(defaultTitle)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the task')
    }
  }

  if (!open) {
    return (
      <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Create task
      </Button>
    )
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-neutral-200 bg-white p-2.5">
      <div className="space-y-1">
        <Label htmlFor="task-title" className="text-xs">
          Task
        </Label>
        <Input
          id="task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="task-assignee" className="text-xs">
          Assign to
        </Label>
        <Select
          id="task-assignee"
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
        >
          <option value={meId}>Me</option>
          {(users.data ?? [])
            .filter((u) => u.id !== meId)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email}
              </option>
            ))}
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={create.isPending || !title.trim()}
          onClick={submit}
        >
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
