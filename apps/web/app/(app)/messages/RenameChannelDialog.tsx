// Rename / edit-topic dialog (ADR 0022). Manager+. #general cannot be renamed
// (the server enforces this too).

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import type { ChannelView } from './types'

interface Props {
  channel: ChannelView
  onClose: () => void
}

export function RenameChannelDialog({ channel, onClose }: Props) {
  const utils = trpc.useUtils()
  const [name, setName] = useState(channel.name ?? '')
  const [topic, setTopic] = useState(channel.topic ?? '')

  const update = trpc.chat.updateChannel.useMutation({
    onSuccess: () => {
      toast.success('Channel updated')
      void utils.chat.listChannels.invalidate()
      void utils.chat.getChannel.invalidate({ id: channel.id })
      onClose()
    },
    onError: (e) => toast.error(e.message ?? 'Could not update channel'),
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Edit channel"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">Edit channel</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100"
          >
            <XIcon size={16} />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <Label htmlFor="rn-name">Name</Label>
            <Input
              id="rn-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1"
              maxLength={60}
            />
          </div>
          <div>
            <Label htmlFor="rn-topic">Topic</Label>
            <Textarea
              id="rn-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="mt-1 min-h-[60px]"
              maxLength={200}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={update.isPending || name.trim().length === 0}
            onClick={() =>
              update.mutate({ id: channel.id, name, topic: topic.trim() || null })
            }
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
