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
          // Layout notes. The real cause of the old "glitchy, bottom-left,
          // misaligned" toasts was the CSP: `style-src` was nonce-only with no
          // `'unsafe-inline'`, which stripped sonner's injected stylesheet AND
          // its inline positioning/stacking styles, dropping the toaster out of
          // its fixed corner into a static document-flow stack. That is fixed in
          // apps/web/lib/security/csp.ts (style-src now allows 'unsafe-inline';
          // scripts stay strict). The class overrides below are pure polish on
          // top of sonner's now-working base styles:
          //  - width stays at sonner's native 356px — forcing a narrower card
          //    breaks the stacking/slide maths and makes toasts jump as they
          //    settle;
          //  - no backdrop-blur — blur on a transforming element flickers on
          //    many GPUs while the toast animates in;
          //  - items-start + a nudged icon so multi-line error text aligns
          //    with the icon's first line instead of floating mid-card;
          //  - min-w-0 + break-words so long provider errors and request ids
          //    wrap instead of overflowing the card edge.
          toast:
            '!rounded-xl !border !border-neutral-200 !bg-white !text-neutral-800 !shadow-[0_8px_30px_rgb(0,0,0,0.10)] !py-3 !px-3.5 !gap-2.5 !w-[356px] !items-start !font-sans',
          content: '!min-w-0',
          title:
            '!text-[13px] !font-medium !leading-snug !text-neutral-900 !break-words',
          description: '!text-xs !text-neutral-500 !break-words',
          icon: '!mt-px !self-start',
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
