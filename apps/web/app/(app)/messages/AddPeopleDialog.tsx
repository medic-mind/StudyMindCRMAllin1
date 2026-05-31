// Add-people-to-channel dialog (ADR 0022). Manager+. Adds each picked teammate
// as a member of the channel.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import { MemberPicker } from './MemberPicker'

interface Props {
  channelId: string
  onClose: () => void
}

export function AddPeopleDialog({ channelId, onClose }: Props) {
  const utils = trpc.useUtils()
  const [ids, setIds] = useState<string[]>([])

  const addMember = trpc.chat.addMember.useMutation()

  async function submit() {
    if (ids.length === 0) return
    try {
      for (const userId of ids) {
        await addMember.mutateAsync({ channelId, userId })
      }
      toast.success(ids.length === 1 ? 'Added 1 person' : `Added ${ids.length} people`)
      void utils.chat.members.invalidate({ channelId })
      void utils.chat.listChannels.invalidate()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add people')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Add people"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">Add people</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100"
          >
            <XIcon size={16} />
          </button>
        </div>
        <div className="px-5 py-4">
          <Label>People</Label>
          <div className="mt-1.5">
            <MemberPicker selectedIds={ids} onChange={setIds} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={addMember.isPending || ids.length === 0} onClick={submit}>
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}
