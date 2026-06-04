// Branded guarded-confirm dialog (CLAUDE.md §26, §34 — make risky actions
// deliberate). Replaces native window.confirm with an accessible <Modal> that
// states what will happen and whether it's reversible. Promise-based so call
// sites read like `if (await confirm({...})) { … }`.
//
// Mount <ConfirmProvider> once in the app shell; call `const confirm =
// useConfirm()` anywhere beneath it.

'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'

import { Button } from './button'
import { Modal } from './modal'

export interface ConfirmOptions {
  title: string
  /** Supporting copy — what happens, and what the agent can still do. */
  body?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** `danger` tints the confirm button red for destructive actions. */
  tone?: 'default' | 'danger'
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/** Returns a promise-based confirm. Throws if no provider is mounted so the
 * mistake is caught in dev rather than silently no-op'ing a guard. */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext)
  if (!fn) throw new Error('useConfirm must be used within <ConfirmProvider>')
  return fn
}

interface PendingState extends ConfirmOptions {
  resolve: (value: boolean) => void
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null)
  const resolveRef = useRef<((v: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setPending({ ...opts, resolve })
    })
  }, [])

  const settle = useCallback((value: boolean) => {
    resolveRef.current?.(value)
    resolveRef.current = null
    setPending(null)
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={pending !== null}
        onClose={() => settle(false)}
        title={pending?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button type="button" size="sm" variant="ghost" onClick={() => settle(false)}>
              {pending?.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={pending?.tone === 'danger' ? 'destructive' : 'default'}
              onClick={() => settle(true)}
            >
              {pending?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {pending?.body ? (
          <div className="px-4 py-3 text-sm text-neutral-600">{pending.body}</div>
        ) : (
          <div className="px-4 py-3" />
        )}
      </Modal>
    </ConfirmContext.Provider>
  )
}
