'use client'

// A small, friendly rich-text editor for non-technical staff — no HTML knowledge
// needed. Dependency-free: a toolbar over a contentEditable region using the
// built-in formatting commands, plus an optional "Insert field" menu for
// {{placeholders}}. Emits HTML via onChange; the caller derives a plain-text
// fallback (lib/html-text). Uncontrolled (seeded once from `initialHtml`) so the
// caret never jumps while typing.

import { useEffect, useRef, useState } from 'react'

import {
  BoldIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  StrikethroughIcon,
} from '@/components/ui/icon'

export interface RichTextField {
  /** Token inserted into the body, e.g. "{{studentName}}". */
  token: string
  /** Friendly label shown in the menu, e.g. "Student name". */
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

function exec(command: string, value?: string): void {
  // execCommand is deprecated but is the only dependency-free cross-browser way
  // to drive a contentEditable region; fine for an internal admin editor.
  document.execCommand(command, false, value)
}

export function RichTextEditor({ initialHtml, onChange, fields, disabled, resetKey }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [fieldsOpen, setFieldsOpen] = useState(false)

  // Seed the editable region once on mount (and whenever `resetKey` changes).
  // We deliberately do NOT depend on `initialHtml`: re-seeding on an unrelated
  // re-render would wipe the user's edits and jump the caret. `initialHtmlRef`
  // gives the effect the latest value without making it a dependency.
  const initialHtmlRef = useRef(initialHtml)
  initialHtmlRef.current = initialHtml
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtmlRef.current
  }, [resetKey])

  function emit(): void {
    if (ref.current) onChange(ref.current.innerHTML)
  }

  function run(command: string, value?: string): void {
    if (disabled) return
    ref.current?.focus()
    exec(command, value)
    emit()
  }

  function insertField(token: string): void {
    if (disabled) return
    ref.current?.focus()
    exec('insertText', token)
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
              Insert field ▾
            </button>
            {fieldsOpen ? (
              <div className="absolute right-0 z-10 mt-1 max-h-64 w-56 overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
                {fields.map((f) => (
                  <button
                    key={f.token}
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
                    onClick={() => insertField(f.token)}
                  >
                    <span className="text-neutral-800">{f.label}</span>
                    <code className="ml-2 rounded bg-neutral-100 px-1 text-[10px] text-neutral-500">
                      {f.token}
                    </code>
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
        className="prose-sm min-h-[200px] max-w-none px-3 py-2 text-sm leading-relaxed text-neutral-800 focus:outline-none [&_a]:text-primary-700 [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"
      />
    </div>
  )
}
