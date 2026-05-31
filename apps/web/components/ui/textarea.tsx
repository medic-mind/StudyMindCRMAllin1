import { forwardRef, type TextareaHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...rest }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        // Matches Input — brand-matched focus ring, soft hover.
        'flex min-h-[80px] w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900',
        'transition-colors',
        'placeholder:text-neutral-400 hover:border-neutral-400',
        'focus-visible:outline-none focus-visible:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-500/30',
        'disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500',
        className,
      )}
      {...rest}
    />
  ),
)
Textarea.displayName = 'Textarea'
