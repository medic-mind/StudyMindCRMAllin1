// Tasks section. Open tasks at top; closed tasks in a collapsed group.

'use client'

import { useState } from 'react'

import type { TaskEntry } from '@/lib/view-models/contact-channels'

interface Props {
  open: TaskEntry[]
  closed: TaskEntry[]
}

function TaskRow({ task }: { task: TaskEntry }) {
  return (
    <li className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm">
      <span className="text-neutral-900">{task.title}</span>
      <span className="flex items-center gap-2 text-xs text-neutral-500">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 uppercase">
          {task.status}
        </span>
        {task.dueAt && (
          <time dateTime={new Date(task.dueAt).toISOString()}>
            due{' '}
            {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
              new Date(task.dueAt),
            )}
          </time>
        )}
      </span>
    </li>
  )
}

export function TasksSection({ open, closed }: Props): JSX.Element {
  const [showClosed, setShowClosed] = useState(false)
  if (open.length === 0 && closed.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-600">
        No tasks for this contact yet — tasks created here or synced from Asana
        will appear in this list.
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {open.length > 0 ? (
        <ol className="space-y-2">
          {open.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-neutral-600">No open tasks.</p>
      )}
      {closed.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowClosed((s) => !s)}
            className="text-xs text-neutral-600 hover:underline"
            aria-expanded={showClosed}
          >
            {showClosed ? 'Hide' : 'Show'} {closed.length} closed task
            {closed.length === 1 ? '' : 's'}
          </button>
          {showClosed && (
            <ol className="mt-2 space-y-2 opacity-70">
              {closed.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
