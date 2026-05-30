// Country select. Stores the English display name (matches existing
// free-text columns). Renders the flag emoji next to the name in the
// dropdown and next to the picked value so the address block always
// has a visual cue.

'use client'

import { COUNTRIES, flagForCountryName } from './countries'

interface Props {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Allow the empty option ("— Select country —"). Default true. */
  allowEmpty?: boolean
}

const SELECT_CLS =
  'h-9 w-full rounded-md border border-neutral-200 bg-white px-2 text-sm text-neutral-900 shadow-sm transition-colors focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500'

export function CountrySelect({
  id,
  value,
  onChange,
  placeholder = '— Select country —',
  disabled,
  className,
  allowEmpty = true,
}: Props) {
  // If the existing value is a free-text country that isn't in our list,
  // keep it as an extra option so we don't silently drop it.
  const inList = value === '' || COUNTRIES.some((c) => c.name === value)

  return (
    <div className={className}>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={SELECT_CLS}
        >
          {allowEmpty && <option value="">{placeholder}</option>}
          {!inList && (
            <option value={value}>{value} (current value)</option>
          )}
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.name}>
              {c.flag} {c.name}
            </option>
          ))}
        </select>
      </div>
      {value && inList ? (
        <p className="mt-1 text-xs text-neutral-500">
          {flagForCountryName(value)} {value}
        </p>
      ) : null}
    </div>
  )
}
