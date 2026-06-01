// Form Field wrapper. Pairs a label with its control, an optional helper /
// error message, and (when `required`) a subtle red asterisk. Standardises
// spacing across every form so the contact-create form, account-create
// form, settings forms, and the user-invite dialog all line up.
//
// The control is passed in as `children` (an Input / Select / Textarea /
// custom widget). We accept `htmlFor` + `id` and wire them automatically
// if the caller omits one; otherwise we honour the explicit ids.
//
// Error wins over helper — a field showing an error doesn't double-stack
// helper text below.

import { useId, type ReactNode } from 'react'

import { cn } from '@/lib/cn'

interface FieldProps {
  /** Visible label. Always present (a11y — no orphaned controls). */
  label: ReactNode
  /** Mark the field as required — adds the asterisk + sets aria-required on
   *  the labelled control if we wire the id automatically. */
  required?: boolean
  /** Helper / hint text. Hidden when an `error` is set. */
  hint?: ReactNode
  /** Validation error. Visually distinct from `hint`; wins when both set. */
  error?: ReactNode
  /** Override the auto-generated id used to link label ↔ control. */
  htmlFor?: string
  /** Extra className on the wrapper. */
  className?: string
  children: ReactNode
}

export function Field({
  label,
  required,
  hint,
  error,
  htmlFor,
  className,
  children,
}: FieldProps) {
  const autoId = useId()
  const id = htmlFor ?? autoId
  const describedById = `${id}-desc`
  const hasError = Boolean(error)
  return (
    <div className={cn('space-y-1.5', className)}>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-neutral-800"
      >
        {label}
        {required ? (
          <span aria-hidden className="ml-1 text-red-500">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hasError ? (
        <p
          id={describedById}
          role="alert"
          className="text-xs font-medium text-red-700"
        >
          {error}
        </p>
      ) : hint ? (
        <p id={describedById} className="text-xs text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Helper hook returning the same `id` / `aria-describedby` pair that
 * Field generates — useful when the consumer's control is composed (e.g. a
 * RHF controller) and needs to wire those props itself.
 */
export function useFieldIds(htmlFor?: string) {
  const autoId = useId()
  const id = htmlFor ?? autoId
  return { id, describedBy: `${id}-desc` }
}
