'use client'

// Pick your own preset profile picture. Saves on selection (no separate button).

import { useState } from 'react'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { AvatarPicker } from '@/components/ui/avatar-picker'
import { trpc } from '@/lib/trpc/client'

export function AvatarSection({
  name,
  email,
  initialAvatarKey,
}: {
  name: string | null
  email: string
  initialAvatarKey: string | null
}) {
  const [avatarKey, setAvatarKey] = useState<string | null>(initialAvatarKey)
  const displayName = name?.trim() || email
  const utils = trpc.useUtils()
  const save = trpc.account.setAvatar.useMutation({
    onSuccess: (r) => {
      setAvatarKey(r.avatarKey)
      // Refresh the top-bar avatar immediately.
      void utils.account.me.invalidate()
      toast.success('Profile picture updated')
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar name={displayName} avatarKey={avatarKey} size={48} />
        <div>
          <h2 className="text-sm font-medium text-neutral-900">Profile picture</h2>
          <p className="text-xs text-neutral-500">Pick one of the presets, or keep your initials.</p>
        </div>
      </div>
      <AvatarPicker
        name={displayName}
        value={avatarKey}
        disabled={save.isPending}
        onChange={(key) => save.mutate({ avatarKey: key })}
      />
    </section>
  )
}
