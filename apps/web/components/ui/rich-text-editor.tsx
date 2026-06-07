'use client'

// A friendly, fully-visual rich-text editor for non-technical staff. No HTML and
// no special characters: formatting is a toolbar, and merge fields appear as
// tidy labelled "chips" (e.g. a pill that reads "First name"), inserted from a
// menu — never raw {{tokens}}. Dependency-free (contentEditable + the built-in
// formatting commands).
//
// Internally the editor renders each merge field as an atomic, non-editable
// chip; on every change it serialises chips back to {{token}} text, so callers
// keep storing the same template strings as before (rendered server-side with
// renderTemplate). On seed it converts stored {{token}}s into chips.

import { useEffect, useRef, useState } from 'react'

import {
  BoldIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  StrikethroughIcon,
} from '@/components/ui/icon'
import { escapeHtml } from '@/lib/html-text'

export interface RichTextField {
  /** Token stored in the template, e.g. "{{studentName}}". */
  token: string
  /** Friendly label shown on the chip + in the menu, e.g. "Student name". */
  label: string
}

interface Props {
  initialHtml: string
  onChange: (html: string) => void
  fields?: RichTextField[]
  disabled?: boolean
  /** Bump to force the editor to re-seed from initialHtml (e.g. after reset). */
  resetKey?: string | number
}

const CHIP_CLASS =
  'sm-field rounded bg-primary-100 px-1.5 py-0.5 text-[0.85em] font-medium text-primary-800'

function keyOf(token: string): string {
  return token.replace(/[{}]/g, '').trim()
}

/** Stored template ({{token}}) → editor HTML (labelled chips for known fields). */
function tokensToChips(html: string, labelByKey: Map<string, string>): string {
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    const label = labelByKey.get(key)
    if (!label) return whole
    return `<span class="${CHIP_CLASS}" data-field="${key}" contenteditable="false">${escapeHtml(label)}</span>`
  })
}

/** Editor HTML (chips) → stored template ({{token}} text). Non-mutating. */
function chipsToTokens(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  div.querySelectorAll('span[data-field]').forEach((el) => {
    const key = el.getAttribute('data-field') ?? ''
    el.replaceWith(document.createTextNode(`{{${key}}}`))
  })
  return div.innerHTML
}

function exec(command: string, value?: string): void {
  // execCommand is deprecated but the only dependency-free, cross-browser way to
  // drive a contentEditable region; fine for an internal admin editor.
  document.execCommand(command, false, value)
}

export function RichTextEditor({ initialHtml, onChange, fields, disabled, resetKey }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [fieldsOpen, setFieldsOpen] = useState(false)

  const labelByKey = new Map((fields ?? []).map((f) => [keyOf(f.token), f.label]))
  const labelByKeyRef = useRef(labelByKey)
  labelByKeyRef.current = labelByKey

  // Seed once on mount (and when resetKey changes). Never re-seed on keystroke —
  // that would wipe edits / jump the caret. A ref carries the latest initial.
  const initialRef = useRef(initialHtml)
  initialRef.current = initialHtml
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = tokensToChips(initialRef.current, labelByKeyRef.current)
  }, [resetKey])

  function emit(): void {
    if (ref.current) onChange(chipsToTokens(ref.current.innerHTML))
  }

  function run(command: string, value?: string): void {
    if (disabled) return
    ref.current?.focus()
    exec(command, value)
    emit()
  }

  function insertField(token: string, label: string): void {
    if (disabled) return
    ref.current?.focus()
    const chip = `<span class="${CHIP_CLASS}" data-field="${keyOf(token)}" contenteditable="false">${escapeHtml(label)}</span>&nbsp;`
    exec('insertHTML', chip)
    setFieldsOpen(false)
    emit()
  }

  function addLink(): void {
    if (disabled) return
    const url = window.prompt('Link URL (https://…)')
    if (url) run('createLink', url)
  }

  const btn =
    'inline-flex h-8 min-w-8 items-center justify-center rounded px-2 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50'

  return (
    <div className="rounded-md border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-neutral-100 px-1.5 py-1">
        <button type="button" className={btn} onClick={() => run('bold')} disabled={disabled} title="Bold" aria-label="Bold">
          <BoldIcon size={15} />
        </button>
        <button type="button" className={btn} onClick={() => run('italic')} disabled={disabled} title="Italic" aria-label="Italic">
          <ItalicIcon size={15} />
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => run('strikeThrough')}
          disabled={disabled}
          title="Strikethrough"
          aria-label="Strikethrough"
        >
          <StrikethroughIcon size={15} />
        </button>
        <span className="mx-1 h-5 w-px bg-neutral-200" />
        <button
          type="button"
          className={btn}
          onClick={() => run('formatBlock', 'H2')}
          disabled={disabled}
          title="Heading"
          aria-label="Heading"
        >
          <span className="text-sm font-bold">H</span>
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => run('insertUnorderedList')}
          disabled={disabled}
          title="Bullet list"
          aria-label="Bullet list"
        >
          <ListIcon size={15} />
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => run('insertOrderedList')}
          disabled={disabled}
          title="Numbered list"
          aria-label="Numbered list"
        >
          <ListOrderedIcon size={15} />
        </button>
        <button type="button" className={btn} onClick={addLink} disabled={disabled} title="Link" aria-label="Link">
          <LinkIcon size={15} />
        </button>

        {fields && fields.length > 0 ? (
          <div className="relative ml-auto">
            <button
              type="button"
              className="inline-flex h-8 items-center rounded px-2 text-sm font-medium text-primary-700 hover:bg-primary-50 disabled:opacity-50"
              onClick={() => setFieldsOpen((o) => !o)}
              disabled={disabled}
            >
              + Insert field
            </button>
            {fieldsOpen ? (
              <div className="absolute right-0 z-10 mt-1 max-h-64 w-56 overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
                {fields.map((f) => (
                  <button
                    key={f.token}
                    type="button"
                    className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-800 hover:bg-neutral-50"
                    onClick={() => insertField(f.token, f.label)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        role="textbox"
        aria-multiline="true"
        className="min-h-[200px] max-w-none px-3 py-2 text-sm leading-relaxed text-neutral-800 focus:outline-none [&_a]:text-primary-700 [&_a]:underline [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-base [&_h2]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"
      />
    </div>
  )
}
