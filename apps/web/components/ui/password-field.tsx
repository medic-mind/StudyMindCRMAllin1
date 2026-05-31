'use client'

// Password input with a show/hide toggle. Wraps the styled Input and forwards
// the ref so it drops into React Hook Form via {...register('password')}.
// CLAUDE.md §28 — the toggle is a real, keyboard-reachable button.

import { forwardRef, useState, type InputHTMLAttributes } from 'react'

import { Input } from './input'

export type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField({ className, ...props }, ref) {
    const [visible, setVisible] = useState(false)
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={`pr-16 ${className ?? ''}`}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-xs font-medium text-neutral-500 hover:text-neutral-800"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    )
  },
)
