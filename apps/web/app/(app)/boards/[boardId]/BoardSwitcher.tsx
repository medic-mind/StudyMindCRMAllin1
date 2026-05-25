// Board switcher dropdown on the board page. ADR 0018. Navigates between
// boards without a full reload of the chrome.

'use client'

import { useRouter } from 'next/navigation'

interface BoardOption {
  id: string
  name: string
}

interface Props {
  boards: ReadonlyArray<BoardOption>
  currentId: string
}

export function BoardSwitcher({ boards, currentId }: Props) {
  const router = useRouter()
  if (boards.length <= 1) return null
  return (
    <label className="block">
      <span className="sr-only">Switch board</span>
      <select
        value={currentId}
        onChange={(e) => router.push(`/boards/${e.target.value}`)}
        className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-800 hover:bg-neutral-50"
        aria-label="Switch board"
      >
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  )
}
