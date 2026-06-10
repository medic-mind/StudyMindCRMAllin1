// Call-recording audio player. Native controls (accurate now the /api/internal
// audio route supports HTTP Range) plus a 1× / 1.5× / 2× speed selector for
// working through recordings fast. Shared by the contact Calls section and the
// Call history page.

'use client'

import { useRef, useState } from 'react'

const PLAYBACK_RATES = [1, 1.5, 2] as const

export function RecordingPlayer({ src }: { src: string }): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  const [rate, setRate] = useState<number>(1)

  const apply = (r: number) => {
    setRate(r)
    if (ref.current) ref.current.playbackRate = r
  }

  return (
    <div className="space-y-1">
      <audio
        ref={ref}
        controls
        preload="metadata"
        className="w-full"
        src={src}
        onLoadedMetadata={() => {
          // Re-apply the chosen rate once the element (re)loads its media.
          if (ref.current) ref.current.playbackRate = rate
        }}
      >
        Your browser does not support inline audio playback.
      </audio>
      <div className="flex items-center gap-1">
        <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
          Speed
        </span>
        {PLAYBACK_RATES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => apply(r)}
            aria-pressed={rate === r}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
              rate === r
                ? 'bg-primary-600 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {r}×
          </button>
        ))}
      </div>
    </div>
  )
}
