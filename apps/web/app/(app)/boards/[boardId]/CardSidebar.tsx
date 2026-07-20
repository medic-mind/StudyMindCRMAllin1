// Right-rail for the card detail modal. Surfaces the card-level metadata
// (assignee, due date, priority, labels, stage, backing contact) and
// makes each field inline-editable so the modal feels like a proper task
// ticket — Todoist-style.
//
// CLAUDE.md §26 — client island; mutations gate server-side. All writes
// go through card.update (audited).

'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import {
  formatLondon,
  londonWallToUtc,
  utcToLondonWall,
} from '@/lib/format/london-time'
import { trpc } from '@/lib/trpc/client'

interface Card {
  id: string
  contactId: string
  contactName: string
  contactEmail: string | null
  contactPhone: string | null
  stage: { id: string; name: string; color: string }
  board: { id: string; name: string }
  assigneeId: string | null
  assigneeName: string | null
  assigneeEmail: string | null
  dueAt: Date | string | null
  scheduledCallAt: Date | string | null
  priority: number | null
  labels: ReadonlyArray<{ id: string; name: string; color: string }>
}

interface Props {
  card: Card
  canWrite: boolean
}

const PRIORITY_LABELS: Record<number, string> = {
  1: 'P1 — Urgent',
  2: 'P2 — High',
  3: 'P3 — Medium',
  4: 'P4 — Low',
}

const PRIORITY_TONE: Record<number, string> = {
  1: 'bg-red-100 text-red-800 ring-1 ring-red-200',
  2: 'bg-orange-100 text-orange-800 ring-1 ring-orange-200',
  3: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  4: 'bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200',
}

function isoDate(d: Date | string | null | undefined): string {
  if (!d) return ''
  return new Date(d).toISOString().slice(0, 10)
}

function formatDueRow(d: Date | string | null) {
  if (!d) return null
  const date = new Date(d)
  const now = new Date()
  const overdue = date.getTime() < now.getTime()
  const text = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(date)
  return { text, overdue }
}

export function CardSidebar({ card, canWrite }: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const usersQuery = trpc.team.assignableUsers.useQuery({}, { enabled: canWrite })

  const update = trpc.card.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.card.get.invalidate({ id: card.id }),
        utils.card.list.invalidate(),
      ])
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not save'),
  })

  const due = formatDueRow(card.dueAt)
  const assigneeLabel = card.assigneeName ?? card.assigneeEmail ?? 'Unassigned'

  return (
    <aside className="space-y-4 border-l border-neutral-100 bg-neutral-50/60 px-5 py-4">
      <Section label="Assignee">
        {canWrite ? (
          <select
            value={card.assigneeId ?? ''}
            onChange={(e) =>
              update.mutate({
                id: card.id,
                assigneeId: e.target.value === '' ? null : e.target.value,
              })
            }
            className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
          >
            <option value="">Unassigned</option>
            {(usersQuery.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-neutral-800">{assigneeLabel}</p>
        )}
      </Section>

      <Section label="Due">
        {canWrite ? (
          <input
            type="date"
            value={isoDate(card.dueAt)}
            onChange={(e) =>
              update.mutate({
                id: card.id,
                dueAt: e.target.value ? new Date(e.target.value) : null,
              })
            }
            className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
          />
        ) : due ? (
          <p
            className={
              due.overdue
                ? 'text-sm font-medium text-red-700'
                : 'text-sm text-neutral-800'
            }
          >
            {due.text}
            {due.overdue ? ' · overdue' : ''}
          </p>
        ) : (
          <p className="text-sm text-neutral-400">No due date</p>
        )}
      </Section>

      <Section label="Call time">
        {canWrite ? (
          <div className="space-y-1">
            <input
              type="datetime-local"
              value={utcToLondonWall(card.scheduledCallAt)}
              onChange={(e) =>
                update.mutate({
                  id: card.id,
                  // The picker value is read as Europe/London wall-clock and
                  // stored UTC (CLAUDE.md §29).
                  scheduledCallAt: e.target.value
                    ? londonWallToUtc(e.target.value)
                    : null,
                })
              }
              className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
            />
            <p className="text-[10px] text-neutral-400">
              {card.scheduledCallAt
                ? `${formatLondon(card.scheduledCallAt)} · UK time`
                : 'UK time (Europe/London)'}
            </p>
          </div>
        ) : card.scheduledCallAt ? (
          <p className="text-sm text-neutral-800">
            {formatLondon(card.scheduledCallAt)}
            <span className="ml-1 text-xs text-neutral-400">UK</span>
          </p>
        ) : (
          <p className="text-sm text-neutral-400">No call scheduled</p>
        )}
      </Section>

      <Section label="Priority">
        {canWrite ? (
          <select
            value={card.priority ?? ''}
            onChange={(e) =>
              update.mutate({
                id: card.id,
                priority: e.target.value === '' ? null : Number(e.target.value),
              })
            }
            className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
          >
            <option value="">None</option>
            {[1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        ) : card.priority != null ? (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${PRIORITY_TONE[card.priority]}`}
          >
            {PRIORITY_LABELS[card.priority]}
          </span>
        ) : (
          <p className="text-sm text-neutral-400">None</p>
        )}
      </Section>

      <Section label="Stage">
        <Badge tone="neutral">{card.stage.name}</Badge>
      </Section>

      {card.labels.length > 0 && (
        <Section label="Labels">
          <div className="flex flex-wrap gap-1">
            {card.labels.map((l) => (
              <span
                key={l.id}
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                style={{ backgroundColor: l.color }}
              >
                {l.name}
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section label="Board">
        <Link
          href={`/boards/${card.board.id}`}
          className="text-sm text-primary-700 hover:underline"
        >
          {card.board.name}
        </Link>
      </Section>

      <Section label="Contact">
        <div className="space-y-1">
          <Link
            href={`/contacts/${card.contactId}`}
            className="block text-sm font-medium text-primary-700 hover:underline"
          >
            {card.contactName}
          </Link>
          {card.contactEmail && (
            <a
              href={`mailto:${card.contactEmail}`}
              className="block break-all text-xs text-neutral-600 hover:underline"
            >
              {card.contactEmail}
            </a>
          )}
          {card.contactPhone && (
            <a
              href={`tel:${card.contactPhone}`}
              className="block font-mono text-xs text-neutral-600 hover:underline"
            >
              {card.contactPhone}
            </a>
          )}
        </div>
      </Section>
    </aside>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
        {label}
      </p>
      {children}
    </div>
  )
}
