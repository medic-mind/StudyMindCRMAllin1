// Card surface primitive. Replaces the inline
// `rounded-xl border border-neutral-200 bg-white shadow-card` repeated on
// every list / tile / settings section. Variants:
//
//   - default: a primary surface — list panels, settings tiles
//   - flat: no shadow — for nested surfaces inside another Card
//   - dashed: empty-state framing (no shadow, dashed border)
//
// CardHeader / CardBody / CardFooter are stackable slots when the section
// has a header + content + (optional) footer. For one-off use, drop the
// slots and put children directly inside <Card>.

import { forwardRef, type HTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

type CardVariant = 'default' | 'flat' | 'dashed'

const VARIANTS: Record<CardVariant, string> = {
  default: 'border border-neutral-200 bg-white shadow-card',
  flat: 'border border-neutral-200 bg-white',
  dashed: 'border border-dashed border-neutral-200 bg-white',
}

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant = 'default', ...rest }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-xl', VARIANTS[variant], className)}
      {...rest}
    />
  ),
)
Card.displayName = 'Card'

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3',
        className,
      )}
      {...rest}
    />
  ),
)
CardHeader.displayName = 'CardHeader'

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...rest }, ref) => (
    <h2
      ref={ref}
      className={cn('text-sm font-semibold text-neutral-900', className)}
      {...rest}
    />
  ),
)
CardTitle.displayName = 'CardTitle'

export const CardBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div ref={ref} className={cn('p-5', className)} {...rest} />
  ),
)
CardBody.displayName = 'CardBody'

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-end gap-2 border-t border-neutral-100 bg-neutral-50/60 px-5 py-3',
        className,
      )}
      {...rest}
    />
  ),
)
CardFooter.displayName = 'CardFooter'
