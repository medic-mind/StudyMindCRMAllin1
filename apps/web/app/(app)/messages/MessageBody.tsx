// Renders a stored chat body into markdown + mention chips + entity-reference
// chips (ADR 0022). Block + inline markdown lives in `markdown.tsx`; this
// component is the thin wrapper that builds the ref lookup and applies the
// shared prose styling.

'use client'

import { useMemo } from 'react'

import { renderMessageBody } from './markdown'
import type { MessageRef } from './types'

interface Props {
  body: string
  /** id → display name for mentioned users. */
  userNames: Record<string, string>
  /** Resolved entity refs for this message, keyed lookup by `${type}:${id}`. */
  refs: ReadonlyArray<MessageRef>
  /** The viewer's own id, so "@you" mentions can be highlighted. */
  viewerId: string
}

export function MessageBody({ body, userNames, refs, viewerId }: Props) {
  const refMap = useMemo(
    () => new Map(refs.map((r) => [`${r.type}:${r.id}`, r] as const)),
    [refs],
  )
  return (
    <div className="space-y-1 text-sm leading-relaxed text-neutral-800">
      {renderMessageBody(body, { userNames, refMap, viewerId })}
    </div>
  )
}
