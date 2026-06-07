// Reusable phone-number input: a country dial-code dropdown (flag + name +
// "+code") next to a national-number field, producing an E.164 string (the
// CRM's stored format — CLAUDE.md §29). Controlled like CountrySelect:
// `value` is the E.164 string, `onChange` emits the new E.164 string.
//
// Dependency-free. The data + parse/compose helpers live in ./phone (pure,
// unit-tested); this file is just the React control.

'use client'

import { useEffect, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'

import { composePhone, parsePhone, PHONE_COUNTRIES } from './phone'

interface Props {
  id?: string
  /** Current E.164 value (e.g. "+447700900123"). */
  value: string
  /** Called with the new E.164 value (or "" when cleared). */
  onChange: (e164: string) => void
  disabled?: boolean
  className?: string
}

const SELECT_CLS =
  'h-9 w-44 shrink-0 rounded-md border border-neutral-200 bg-white px-2 text-sm text-neutral-900 shadow-sm transition-colors focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500'

export function PhoneInput({ id, value, onChange, disabled, className }: Props) {
  const [iso, setIso] = useState(() => parsePhone(value).iso)
  const [national, setNational] = useState(() => parsePhone(value).national)
  // Track the last E.164 we emitted so an external value change (form reset,
  // programmatic set) re-parses, but our own keystrokes don't fight the prop.
  const lastEmitted = useRef<string>(composePhone(iso, national))

  useEffect(() => {
    if ((value ?? '') !== lastEmitted.current) {
      const p = parsePhone(value)
      setIso(p.iso)
      setNational(p.national)
      lastEmitted.current = value ?? ''
    }
  }, [value])

  function emit(nextIso: string, nextNational: string) {
    const e164 = composePhone(nextIso, nextNational)
    lastEmitted.current = e164
    onChange(e164)
  }

  const selected = PHONE_COUNTRIES.find((c) => c.code === iso) ?? null
  const composed = composePhone(iso, national)

  return (
    <div className={className}>
      <div className="flex gap-2">
        <select
          aria-label="Country dialling code"
          value={iso}
          disabled={disabled}
          onChange={(e) => {
            setIso(e.target.value)
            emit(e.target.value, national)
          }}
          className={SELECT_CLS}
        >
          {PHONE_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.flag} {c.name} (+{c.dial})
            </option>
          ))}
        </select>
        <Input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={national}
          disabled={disabled}
          onChange={(e) => {
            setNational(e.target.value)
            emit(iso, e.target.value)
          }}
          placeholder="Phone number"
        />
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        {composed ? (
          <>
            Saved as <span className="font-mono">{composed}</span>
          </>
        ) : (
          'Enter a number'
        )}
        {selected ? (
          <>
            {' · '}
            {selected.flag} {selected.name}
          </>
        ) : null}
      </p>
    </div>
  )
}
