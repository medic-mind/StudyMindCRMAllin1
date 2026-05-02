import { forwardRef, type LabelHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement>

export const Label = forwardRef<HTMLLabelElement, LabelProps>(({ className, ...rest }, ref) => (
  <label
    ref={ref}
    className={cn('text-sm font-medium text-neutral-800', className)}
    {...rest}
  />
))
Label.displayName = 'Label'
