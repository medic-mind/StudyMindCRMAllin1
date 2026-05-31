import { forwardRef, type InputHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

export type InputProps = InputHTMLAttributes<HTMLInputElement>

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, ...rest }, ref) => (
  <input
    ref={ref}
    className={cn(
      // Slightly softer border, brand-matched focus ring (was harsh black
      // ring-neutral-900 before — inconsistent with Button which already
      // uses primary-500). Hover deepens the border so the field reads as
      // interactive before the agent clicks.
      'flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-900',
      'shadow-[inset_0_1px_0_rgba(0,0,0,0.02)] transition-colors',
      'placeholder:text-neutral-400 hover:border-neutral-400',
      'focus-visible:outline-none focus-visible:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-500/30',
      'disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500',
      className,
    )}
    {...rest}
  />
))
Input.displayName = 'Input'
