// Kanban ⇄ List view switch for a board. The choice lives in the URL
// (`?view=list`) so it's shareable and survives refresh (CLAUDE.md §26 — filter
// state in the URL). Defaults to kanban (no param). Preserves any other query
// params already on the URL.

'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

type View = 'kanban' | 'list'

export function BoardViewToggle({ view }: { view: View }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function setView(next: View) {
    if (next === view) return
    const sp = new URLSearchParams(params.toString())
    if (next === 'kanban') sp.delete('view')
    else sp.set('view', next)
    const qs = sp.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const base =
    'inline-flex h-8 items-center gap-1.5 px-3 text-sm font-medium transition-colors'
  const active = 'bg-white text-neutral-900 shadow-sm'
  const inactive = 'text-neutral-600 hover:text-neutral-900'

  return (
    <div
      className="inline-flex rounded-md border border-neutral-200 bg-neutral-100 p-0.5"
      role="group"
      aria-label="Board view"
    >
      <button
        type="button"
        onClick={() => setView('kanban')}
        aria-pressed={view === 'kanban'}
        className={`${base} rounded ${view === 'kanban' ? active : inactive}`}
      >
        Board
      </button>
      <button
        type="button"
        onClick={() => setView('list')}
        aria-pressed={view === 'list'}
        className={`${base} rounded ${view === 'list' ? active : inactive}`}
      >
        List
      </button>
    </div>
  )
}
