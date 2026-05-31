// Create-channel dialog (ADR 0022). Manager+. Name is slugified server-side;
// the preview shows the resulting #slug. Public or private, with an optional
// initial-member picker for private channels.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { HashIcon, LockIcon, XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import { MemberPicker } from './MemberPicker'

interface Props {
  onClose: () => void
  onCreated: (channelId: string) => void
}

function slugPreview(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
}

export function CreateChannelDialog({ onClose, onCreated }: Props) {
  const utils = trpc.useUtils()
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [kind, setKind] = useState<'public' | 'private'>('public')
  const [memberIds, setMemberIds] = useState<string[]>([])

  const create = trpc.chat.createChannel.useMutation({
    onSuccess: (res) => {
      toast.success(`#${res.name} created`)
      void utils.chat.listChannels.invalidate()
      onCreated(res.id)
    },
    onError: (e) => toast.error(e.message ?? 'Could not create channel'),
  })

  const slug = slugPreview(name)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create a channel"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">Create a channel</h2>
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
            <Label htmlFor="ch-name">Name</Label>
            <div className="relative mt-1">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400">
                <HashIcon size={15} />
              </span>
              <Input
                id="ch-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. sales-wins"
                className="pl-8"
                autoFocus
                maxLength={60}
              />
            </div>
            {slug ? (
              <p className="mt-1 text-xs text-neutral-500">
                Will be created as <span className="font-medium text-neutral-700">#{slug}</span>
              </p>
            ) : null}
          </div>

          <div>
            <Label htmlFor="ch-topic">Topic (optional)</Label>
            <Textarea
              id="ch-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What is this channel about?"
              className="mt-1 min-h-[60px]"
              maxLength={200}
            />
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-neutral-800">Visibility</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setKind('public')}
                className={
                  kind === 'public'
                    ? 'flex items-start gap-2 rounded-lg border border-primary-300 bg-primary-50 p-2.5 text-left ring-1 ring-primary-200'
                    : 'flex items-start gap-2 rounded-lg border border-neutral-200 p-2.5 text-left hover:border-neutral-300'
                }
              >
                <HashIcon size={16} className="mt-0.5 text-neutral-500" />
                <span>
                  <span className="block text-sm font-medium text-neutral-900">Public</span>
                  <span className="block text-xs text-neutral-500">Anyone can find and join</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setKind('private')}
                className={
                  kind === 'private'
                    ? 'flex items-start gap-2 rounded-lg border border-primary-300 bg-primary-50 p-2.5 text-left ring-1 ring-primary-200'
                    : 'flex items-start gap-2 rounded-lg border border-neutral-200 p-2.5 text-left hover:border-neutral-300'
                }
              >
                <LockIcon size={16} className="mt-0.5 text-neutral-500" />
                <span>
                  <span className="block text-sm font-medium text-neutral-900">Private</span>
                  <span className="block text-xs text-neutral-500">Invite-only members</span>
                </span>
              </button>
            </div>
          </fieldset>

          {kind === 'private' ? (
            <div>
              <Label>Members</Label>
              <p className="mb-1.5 text-xs text-neutral-500">
                Add the people who should be in this private channel. You are added automatically.
              </p>
              <MemberPicker selectedIds={memberIds} onChange={setMemberIds} />
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={create.isPending || slug.length === 0}
            onClick={() =>
              create.mutate({
                name,
                kind,
                topic: topic.trim() || undefined,
                memberIds: kind === 'private' ? memberIds : undefined,
              })
            }
          >
            Create channel
          </Button>
        </div>
      </div>
    </div>
  )
}
