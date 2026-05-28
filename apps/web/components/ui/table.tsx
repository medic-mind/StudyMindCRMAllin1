import { forwardRef, type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

export const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement>>(
  ({ className, ...rest }, ref) => (
    <div className="w-full overflow-auto">
      <table ref={ref} className={cn('w-full text-sm', className)} {...rest} />
    </div>
  ),
)
Table.displayName = 'Table'

export const Thead = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...rest }, ref) => (
    <thead
      ref={ref}
      className={cn('border-b border-neutral-200/80 bg-neutral-50/60', className)}
      {...rest}
    />
  ),
)
Thead.displayName = 'Thead'

export const Tbody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...rest }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...rest} />
  ),
)
Tbody.displayName = 'Tbody'

export const Tr = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...rest }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'border-b border-neutral-100/80 transition-colors hover:bg-primary-50/40',
        className,
      )}
      {...rest}
    />
  ),
)
Tr.displayName = 'Tr'

export const Th = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...rest }, ref) => (
    <th
      ref={ref}
      scope="col"
      className={cn(
        'h-11 px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500',
        className,
      )}
      {...rest}
    />
  ),
)
Th.displayName = 'Th'

export const Td = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...rest }, ref) => (
    <td ref={ref} className={cn('px-3 py-3 align-middle', className)} {...rest} />
  ),
)
Td.displayName = 'Td'
