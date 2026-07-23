// An obvious, dependency-free date + time picker (CLAUDE.md §3 — no Radix / no
// new deps). Replaces the native <input type="datetime-local"> on the board
// Add-card form and card sidebar: ops feedback (2026-07) was that the native
// control's calendar affordance is invisible ("I'm not sure how to make the
// calendar appear"). This shows a clear "pick a date & time" button with a
// calendar icon; clicking it EXPANDS a month grid + time selects inline (below
// the field, in the layout flow) so it's never clipped by a scrolling modal —
// the reason an absolutely-positioned popover would be fragile here.
//
// Controlled with the same wall-clock string a datetime-local uses
// ("YYYY-MM-DDTHH:mm"), so the value drops straight into the existing
// londonWallToUtc / utcToLondonWall helpers at the call sites (CLAUDE.md §29).

'use client'

import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XIcon,
} from '@/components/ui/icon'

import {
  buildCalendarWeeks,
  formatWall,
  humanWallLabel,
  monthLabel,
  parseWall,
  shiftMonth,
  type WallParts,
} from './datetime'

interface Props {
  id?: string
  /** Current value as a "YYYY-MM-DDTHH:mm" wall-clock string, or "". */
  value: string
  /** Emits the new wall-clock string, or "" when cleared. */
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  /** Hour used when a day is picked before any time is chosen. Default 9. */
  defaultHour?: number
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]

export function DateTimePicker({
  id,
  value,
  onChange,
  disabled,
  className,
  defaultHour = 9,
}: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const parsed = parseWall(value)
  const today = new Date()
  // Which month the grid is showing. Follows the selected value; falls back to
  // the current month when nothing is picked yet.
  const [view, setView] = useState(() => ({
    year: parsed?.year ?? today.getFullYear(),
    month: parsed?.month ?? today.getMonth() + 1,
  }))

  // When the panel opens, jump the grid to the selected month (or this month).
  useEffect(() => {
    if (!open) return
    const p = parseWall(value)
    const now = new Date()
    setView({ year: p?.year ?? now.getFullYear(), month: p?.month ?? now.getMonth() + 1 })
  }, [open, value])

  // Outside-click + Escape close (Escape swallowed so an enclosing modal stays).
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function emit(next: WallParts) {
    onChange(formatWall(next))
  }

  function pickDay(day: number) {
    const base = parseWall(value)
    emit({
      year: view.year,
      month: view.month,
      day,
      hour: base?.hour ?? defaultHour,
      minute: base?.minute ?? 0,
    })
  }

  function setTime(part: 'hour' | 'minute', n: number) {
    const now = new Date()
    const base =
      parseWall(value) ?? {
        // No day picked yet — anchor the time to today so a time-first choice
        // still produces a valid value.
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        hour: defaultHour,
        minute: 0,
      }
    emit({ ...base, [part]: n })
  }

  function clear() {
    onChange('')
  }

  const weeks = buildCalendarWeeks(view.year, view.month)
  const isSelectedDay = (day: number) =>
    parsed != null && parsed.year === view.year && parsed.month === view.month && parsed.day === day
  const isToday = (day: number) =>
    view.year === today.getFullYear() &&
    view.month === today.getMonth() + 1 &&
    day === today.getDate()

  // Ensure a non-standard stored minute (e.g. :07 from an older value) is still
  // selectable rather than snapping away.
  const minuteChoices =
    parsed && !MINUTE_OPTIONS.includes(parsed.minute)
      ? [...MINUTE_OPTIONS, parsed.minute].sort((a, b) => a - b)
      : MINUTE_OPTIONS

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-md border border-neutral-300 bg-white px-3 text-left text-sm shadow-[inset_0_1px_0_rgba(0,0,0,0.02)] transition-colors',
          'hover:border-neutral-400 focus-visible:outline-none focus-visible:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-500/30',
          'disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500',
        )}
      >
        <CalendarIcon size={15} className="shrink-0 text-neutral-500" />
        {value ? (
          <span className="truncate text-neutral-900">{humanWallLabel(value)}</span>
        ) : (
          <span className="text-neutral-400">Select date &amp; time</span>
        )}
        {value ? (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear date"
            onClick={(e) => {
              e.stopPropagation()
              clear()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                clear()
              }
            }}
            className="ml-auto rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          >
            <XIcon size={13} />
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Choose date and time"
          className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-white p-3 shadow-lg"
        >
          {/* Month navigation */}
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setView((v) => shiftMonth(v.year, v.month, -1))}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            >
              <ChevronLeftIcon size={16} />
            </button>
            <span className="text-sm font-semibold text-neutral-800">
              {monthLabel(view.year, view.month)}
            </span>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setView((v) => shiftMonth(v.year, v.month, 1))}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            >
              <ChevronRightIcon size={16} />
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-0.5">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-neutral-400"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {weeks.flat().map((day, i) =>
              day == null ? (
                <div key={`b${i}`} />
              ) : (
                <button
                  key={day}
                  type="button"
                  onClick={() => pickDay(day)}
                  className={cn(
                    'flex h-8 items-center justify-center rounded-md text-sm tabular-nums transition-colors',
                    isSelectedDay(day)
                      ? 'bg-primary-600 font-semibold text-white'
                      : 'text-neutral-700 hover:bg-primary-50 hover:text-primary-800',
                    !isSelectedDay(day) && isToday(day)
                      ? 'ring-1 ring-inset ring-primary-300'
                      : '',
                  )}
                >
                  {day}
                </button>
              ),
            )}
          </div>

          {/* Time */}
          <div className="mt-3 flex items-center gap-2 border-t border-neutral-100 pt-3">
            <span className="text-xs font-medium text-neutral-500">Time</span>
            <select
              aria-label="Hour"
              value={parsed ? parsed.hour : ''}
              onChange={(e) => setTime('hour', Number(e.target.value))}
              className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-500/30"
            >
              {parsed ? null : <option value="">--</option>}
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}
                </option>
              ))}
            </select>
            <span className="text-sm text-neutral-400">:</span>
            <select
              aria-label="Minute"
              value={parsed ? parsed.minute : ''}
              onChange={(e) => setTime('minute', Number(e.target.value))}
              className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-500/30"
            >
              {parsed ? null : <option value="">--</option>}
              {minuteChoices.map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, '0')}
                </option>
              ))}
            </select>
            <span className="ml-auto text-[10px] text-neutral-400">UK time</span>
          </div>

          {/* Footer actions */}
          <div className="mt-3 flex items-center justify-between border-t border-neutral-100 pt-2.5">
            <button
              type="button"
              onClick={clear}
              className="text-xs font-medium text-neutral-500 hover:text-neutral-800"
            >
              Clear
            </button>
            <Button type="button" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
