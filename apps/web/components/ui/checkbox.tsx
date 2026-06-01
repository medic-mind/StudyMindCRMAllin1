// Checkbox primitive. Standardises the bulk-select and form checkboxes that
// were previously hand-rolled with ad-hoc `h-4 w-4 rounded …` classes on raw
// inputs. Brand-coloured, with a consistent focus ring.

import { forwardRef, type InputHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

export type CheckboxProps = InputHTMLAttributes<HTMLInputElement>

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, ...rest }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        'h-4 w-4 rounded border-neutral-300 text-primary-600',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  ),
)
Checkbox.displayName = 'Checkbox'
