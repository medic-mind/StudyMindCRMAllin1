// Legacy pipeline route. ADR 0018 generalised the single pipeline into
// multiple boards; the old /pipeline now redirects to the default board so
// existing links and bookmarks keep working.

import { redirect } from 'next/navigation'

import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

export default async function PipelineRedirectPage() {
  const caller = await createServerCaller()
  let target = '/boards'
  try {
    const board = await caller.board.getDefault()
    target = `/boards/${board.id}`
  } catch {
    target = '/boards'
  }
  redirect(target)
}
