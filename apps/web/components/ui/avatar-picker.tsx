'use client'

// Preset profile-picture picker. A grid of the preset gradient avatars plus an
// "Initials" option; the selected one is ringed. Presentational — the parent
// owns persistence.

import { Avatar } from './avatar'
import { AVATAR_PRESETS } from './avatar-presets'

export function AvatarPicker({
  name,
  value,
  onChange,
  disabled = false,
}: {
  name: string
  value: string | null
  onChange: (key: string | null) => void
  disabled?: boolean
}) {
  const option = (key: string | null, label: string) => {
    const selected = (value ?? null) === key
    return (
      <button
        key={key ?? 'initials'}
        type="button"
        disabled={disabled}
        onClick={() => onChange(key)}
        aria-pressed={selected}
        title={label}
        className={`flex flex-col items-center gap-1 rounded-lg p-1.5 transition-colors disabled:opacity-50 ${
          selected ? 'bg-primary-50 ring-2 ring-primary-500' : 'hover:bg-neutral-100'
        }`}
      >
        <Avatar name={name} avatarKey={key} size={40} />
        <span className="text-[10px] text-neutral-500">{label}</span>
      </button>
    )
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {option(null, 'Initials')}
      {AVATAR_PRESETS.map((p) => option(p.key, p.label))}
    </div>
  )
}
