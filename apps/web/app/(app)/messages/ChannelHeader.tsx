// Channel header bar (ADR 0022): title, topic, member count, and an actions
// menu (add people, notification level, rename, archive). DMs show the
// participants instead of a hash title.

'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import {
  BellOffIcon,
  HashIcon,
  LockIcon,
  MoreHorizontalIcon,
  UserPlusIcon,
} from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import { AddPeopleDialog } from './AddPeopleDialog'
import { RenameChannelDialog } from './RenameChannelDialog'
import type { ChannelView } from './types'

interface Props {
  channel: ChannelView
  canManage: boolean
}

const NOTIFY_LABEL: Record<string, string> = {
  all: 'All messages',
  mentions: 'Only @mentions',
  none: 'Nothing',
}

export function ChannelHeader({ channel, canManage }: Props) {
  const utils = trpc.useUtils()
  const [menuOpen, setMenuOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const membersQuery = trpc.chat.members.useQuery(
    { channelId: channel.id },
    { staleTime: 30_000 },
  )

  const setNotify = trpc.chat.setNotifyLevel.useMutation({
    onSuccess: () => {
      void utils.chat.listChannels.invalidate()
      void utils.chat.getChannel.invalidate({ id: channel.id })
    },
  })
  const archive = trpc.chat.archiveChannel.useMutation({
    onSuccess: () => {
      toast.success('Channel archived')
      void utils.chat.listChannels.invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not archive'),
  })

  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const Icon = channel.kind === 'private' ? LockIcon : HashIcon
  const memberCount = membersQuery.data?.length ?? 0

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-4">
      <div className="flex min-w-0 items-center gap-2">
        {channel.kind === 'dm' ? (
          <div className="flex -space-x-1.5">
            {channel.dmMembers.slice(0, 3).map((m) => (
              <Avatar key={m.id} name={m.name} size={24} className="ring-2 ring-white" />
            ))}
          </div>
        ) : (
          <Icon size={18} className="text-neutral-400" />
        )}
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-neutral-900">{channel.title}</h1>
          {channel.topic ? (
            <p className="truncate text-xs text-neutral-500">{channel.topic}</p>
          ) : channel.kind !== 'dm' ? (
            <p className="truncate text-xs text-neutral-400">
              {memberCount} {memberCount === 1 ? 'member' : 'members'}
            </p>
          ) : null}
        </div>
        {channel.muted ? (
          <BellOffIcon size={14} className="ml-1 text-neutral-400" />
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        {channel.kind !== 'dm' && canManage ? (
          <button
            type="button"
            aria-label="Add people"
            title="Add people"
            onClick={() => setAddOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
          >
            <UserPlusIcon size={16} />
          </button>
        ) : null}

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            aria-label="Channel options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
          >
            <MoreHorizontalIcon size={18} />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
            >
              <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                Notifications
              </p>
              {(['all', 'mentions', 'none'] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  role="menuitemradio"
                  aria-checked={channel.notifyLevel === level}
                  onClick={() => {
                    setNotify.mutate({ channelId: channel.id, notifyLevel: level })
                    setMenuOpen(false)
                  }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-50"
                >
                  {NOTIFY_LABEL[level]}
                  {channel.notifyLevel === level ? (
                    <span className="text-primary-600">✓</span>
                  ) : null}
                </button>
              ))}

              {canManage && channel.kind !== 'dm' && !channel.isGeneral ? (
                <>
                  <div className="my-1 h-px bg-neutral-100" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setRenameOpen(true)
                      setMenuOpen(false)
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    Rename / edit topic
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      if (confirm(`Archive #${channel.name}? Members lose access until restored.`)) {
                        archive.mutate({ id: channel.id })
                      }
                      setMenuOpen(false)
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-sm text-red-700 hover:bg-red-50"
                  >
                    Archive channel
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {addOpen ? (
        <AddPeopleDialog channelId={channel.id} onClose={() => setAddOpen(false)} />
      ) : null}
      {renameOpen ? (
        <RenameChannelDialog
          channel={channel}
          onClose={() => setRenameOpen(false)}
        />
      ) : null}
    </header>
  )
}
