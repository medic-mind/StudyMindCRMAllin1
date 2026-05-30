// New direct-message dialog (ADR 0022). Pick one or more teammates → opens (or
// reuses) the DM channel. Any staff member.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import { MemberPicker } from './MemberPicker'

interface Props {
  onClose: () => void
  onOpened: (channelId: string) => void
}

export function NewDmDialog({ onClose, onOpened }: Props) {
  const utils = trpc.useUtils()
  const [ids, setIds] = useState<string[]>([])

  const open = trpc.chat.openDm.useMutation({
    onSuccess: (res) => {
      void utils.chat.listChannels.invalidate()
      onOpened(res.id)
    },
    onError: (e) => toast.error(e.message ?? 'Could not open conversation'),
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New direct message"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">New message</h2>
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
          <Label>To</Label>
          <p className="mb-1.5 text-xs text-neutral-500">
            Pick one teammate for a 1:1, or several for a group message.
          </p>
          <MemberPicker selectedIds={ids} onChange={setIds} max={8} />
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={open.isPending || ids.length === 0}
            onClick={() => open.mutate({ userIds: ids })}
          >
            Start conversation
          </Button>
        </div>
      </div>
    </div>
  )
}
