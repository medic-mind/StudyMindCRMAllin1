// Button primitive. The primary variant is the StudyMind purple — that is
// what most CTAs in the CRM should reach for. CLAUDE.md §4 (brand identity).

import { forwardRef, type ButtonHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

type Variant = 'default' | 'secondary' | 'ghost' | 'destructive'
type Size = 'xs' | 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const VARIANTS: Record<Variant, string> = {
  // Brand-forward primary. Subtle shadow + active-state darkening keeps the
  // button feeling responsive without being noisy.
  default:
    'bg-primary-600 text-white shadow-sm hover:bg-primary-700 active:bg-primary-800',
  // Refined "outline" rather than a flat grey fill — reads as paired with
  // the primary instead of competing with it.
  secondary:
    'bg-white text-neutral-800 border border-neutral-200 shadow-sm hover:bg-neutral-50 hover:border-neutral-300 active:bg-neutral-100',
  ghost:
    'bg-transparent text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900 active:bg-neutral-200',
  destructive: 'bg-red-600 text-white shadow-sm hover:bg-red-700 active:bg-red-800',
}

const SIZES: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-xs gap-1.5',
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-10 px-5 text-base gap-2',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...rest }, ref) => (
    <button
      ref={ref}
      className={cn(
        // `transition` (not just colors) so the pressed scale animates too —
        // a ~100ms tactile dip that confirms the click registered even while
        // the mutation/navigation behind it is still in flight (§28: gated
        // under 200ms, plus motion-reduce opt-out).
        'inline-flex items-center justify-center rounded-md font-medium transition duration-100',
        'active:scale-[0.97] motion-reduce:transform-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  ),
)
Button.displayName = 'Button'
