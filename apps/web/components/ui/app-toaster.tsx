// The ONE notification surface for the whole app (CLAUDE.md §26 — a single
// Toaster mounted in the root layout; pages never mount their own).
//
// Audited 2026-06: every transient action confirmation site-wide ("Moved to
// Called once", "Reply sent", "Could not move card", …) goes through
// sonner's toast() and therefore renders here. The only aria-live copy that
// does NOT is inline form validation on the auth screens — that is form
// state, not a notification, and stays inline by design.
//
// Look + behaviour, per the product brief: a small, light card that pops up
// in the BOTTOM-RIGHT corner and quietly disappears on its own. Hovering
// pauses the timer; a subtle close button allows early dismissal; success /
// error / warning keep their semantic colour in the icon only, never as a
// loud full-surface wash.

'use client'

import { Toaster } from 'sonner'

export function AppToaster() {
  return (
    <Toaster
      position="bottom-right"
      duration={4000}
      gap={10}
      offset={20}
      visibleToasts={4}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            '!rounded-xl !border !border-neutral-200/90 !bg-white/95 !text-neutral-800 !shadow-[0_8px_30px_rgb(0,0,0,0.10)] !backdrop-blur !py-3 !px-3.5 !gap-2.5 !w-[320px] !font-sans',
          title: '!text-[13px] !font-medium !leading-snug !text-neutral-900',
          description: '!text-xs !text-neutral-500',
          closeButton:
            '!border-neutral-200 !bg-white !text-neutral-400 hover:!border-neutral-300 hover:!text-neutral-600',
          // Semantic colour lives in the icon, not the surface — calm, not
          // alarming (CLAUDE.md §4 palette intent).
          success: '[&_[data-icon]]:!text-emerald-600',
          error: '[&_[data-icon]]:!text-red-600',
          warning: '[&_[data-icon]]:!text-amber-600',
          info: '[&_[data-icon]]:!text-primary-600',
        },
      }}
    />
  )
}
