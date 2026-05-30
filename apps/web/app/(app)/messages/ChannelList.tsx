// Left rail: the channel + DM list (ADR 0022). Slack-style sections —
// Channels, then Direct messages — each row showing unread (bold + count) and
// @mention (red pill) state. A "+" opens the create-channel dialog (Manager+)
// or the new-DM picker.

'use client'

import { useMemo, useState } from 'react'

import {
  HashIcon,
  LockIcon,
  PlusIcon,
  AtSignIcon,
} from '@/components/ui/icon'
import { Avatar } from '@/components/ui/avatar'

import { CreateChannelDialog } from './CreateChannelDialog'
import { NewDmDialog } from './NewDmDialog'
import type { ChannelView } from './types'

interface Props {
  channels: ChannelView[]
  activeId: string | null
  mentionTotal: number
  canManageChannels: boolean
  onSelect: (id: string) => void
  onSelectMentions: () => void
  mentionsActive: boolean
}

function ChannelRow({
  channel,
  active,
  onSelect,
}: {
  channel: ChannelView
  active: boolean
  onSelect: () => void
}) {
  const unread = channel.unreadCount > 0 && !active
  const Icon = channel.kind === 'private' ? LockIcon : HashIcon

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={
        active
          ? 'flex w-full items-center gap-2 rounded-md bg-primary-600 px-2 py-1.5 text-left text-sm font-medium text-white'
          : unread
            ? 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-neutral-900 hover:bg-neutral-100'
            : 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
      }
    >
      {channel.kind === 'dm' ? (
        <Avatar name={channel.title} size={20} />
      ) : (
        <Icon
          size={15}
          className={active ? 'text-white/80' : 'text-neutral-400'}
        />
      )}
      <span className="flex-1 truncate">{channel.title}</span>
      {channel.mentionCount > 0 ? (
        <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger-600 px-1 text-[10px] font-semibold text-white">
          {channel.mentionCount > 9 ? '9+' : channel.mentionCount}
        </span>
      ) : unread ? (
        <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-neutral-300 px-1 text-[10px] font-semibold text-neutral-700">
          {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
        </span>
      ) : null}
    </button>
  )
}

export function ChannelList({
  channels,
  activeId,
  mentionTotal,
  canManageChannels,
  onSelect,
  onSelectMentions,
  mentionsActive,
}: Props) {
  const [createOpen, setCreateOpen] = useState(false)
  const [dmOpen, setDmOpen] = useState(false)

  const { named, dms } = useMemo(() => {
    const named = channels.filter((c) => c.kind !== 'dm')
    const dms = channels.filter((c) => c.kind === 'dm')
    return { named, dms }
  }, [channels])

  return (
    <nav
      className="flex h-full w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-neutral-200 bg-neutral-50/70 px-2 py-3"
      aria-label="Channels"
    >
      {/* Mentions inbox entry */}
      <button
        type="button"
        onClick={onSelectMentions}
        aria-current={mentionsActive ? 'true' : undefined}
        className={
          mentionsActive
            ? 'flex w-full items-center gap-2 rounded-md bg-primary-600 px-2 py-1.5 text-left text-sm font-medium text-white'
            : 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900'
        }
      >
        <AtSignIcon size={15} className={mentionsActive ? 'text-white/80' : 'text-neutral-400'} />
        <span className="flex-1">Mentions</span>
        {mentionTotal > 0 ? (
          <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger-600 px-1 text-[10px] font-semibold text-white">
            {mentionTotal > 9 ? '9+' : mentionTotal}
          </span>
        ) : null}
      </button>

      {/* Channels */}
      <div>
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
            Channels
          </span>
          {canManageChannels ? (
            <button
              type="button"
              aria-label="Create channel"
              title="Create channel"
              onClick={() => setCreateOpen(true)}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
            >
              <PlusIcon size={14} />
            </button>
          ) : null}
        </div>
        <div className="flex flex-col gap-0.5">
          {named.length === 0 ? (
            <p className="px-2 py-1 text-xs text-neutral-400">No channels yet.</p>
          ) : (
            named.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                active={c.id === activeId}
                onSelect={() => onSelect(c.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Direct messages */}
      <div>
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
            Direct messages
          </span>
          <button
            type="button"
            aria-label="New direct message"
            title="New direct message"
            onClick={() => setDmOpen(true)}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
          >
            <PlusIcon size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-0.5">
          {dms.length === 0 ? (
            <p className="px-2 py-1 text-xs text-neutral-400">
              No direct messages. Start one with the +.
            </p>
          ) : (
            dms.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                active={c.id === activeId}
                onSelect={() => onSelect(c.id)}
              />
            ))
          )}
        </div>
      </div>

      {createOpen ? (
        <CreateChannelDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false)
            onSelect(id)
          }}
        />
      ) : null}
      {dmOpen ? (
        <NewDmDialog
          onClose={() => setDmOpen(false)}
          onOpened={(id) => {
            setDmOpen(false)
            onSelect(id)
          }}
        />
      ) : null}
    </nav>
  )
}
