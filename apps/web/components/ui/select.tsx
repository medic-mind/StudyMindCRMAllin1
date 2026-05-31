import { forwardRef, type SelectHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...rest }, ref) => (
    <select
      ref={ref}
      className={cn(
        // Brand-matched focus ring + hover border so Select reads identically
        // to Input. Padding-right makes room for the native caret.
        'flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 pr-8 text-sm text-neutral-900',
        'shadow-[inset_0_1px_0_rgba(0,0,0,0.02)] transition-colors',
        'hover:border-neutral-400',
        'focus-visible:outline-none focus-visible:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-500/30',
        'disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  ),
)
Select.displayName = 'Select'
