// Tests for the studymind/prefer-card-surface ESLint rule.
// CLAUDE.md §0.5 / §4.

import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('./prefer-card-surface.js')

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

describe('studymind/prefer-card-surface', () => {
  it('flags a hand-rolled bordered white panel on a div/section', () => {
    ruleTester.run('prefer-card-surface', rule, {
      valid: [
        // Already the primitive.
        { code: 'const A = () => <Card className="p-5">x</Card>' },
        // List item — Card (a div) would break <ul>/<ol> semantics.
        {
          code: 'const A = () => <li className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">x</li>',
        },
        // Form — Card would drop onSubmit.
        {
          code: 'const A = () => <form className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">x</form>',
        },
        // Segmented / tablist control (inline-flex) — not a panel.
        {
          code: 'const A = () => <div className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-card">x</div>',
        },
        // Translucent white — not a solid panel.
        {
          code: 'const A = () => <div className="rounded-lg border border-neutral-200 bg-white/90 shadow-card">x</div>',
        },
        // Accent-bordered card (border-l-) — bespoke, not a plain Card.
        {
          code: 'const A = () => <div className="rounded-lg border border-neutral-200 border-l-[3px] bg-white p-3 shadow-card">x</div>',
        },
        // Dynamic className (template literal) is skipped.
        {
          code: 'const A = ({c}) => <div className={`rounded-xl border border-neutral-200 bg-white p-5 shadow-card ${c}`}>x</div>',
        },
        // Only the hover shadow — no static shadow-card panel.
        {
          code: 'const A = () => <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card-hover">x</div>',
        },
        // Plain div without the panel signature.
        { code: 'const A = () => <div className="flex gap-2">x</div>' },
      ],
      invalid: [
        {
          code: 'const A = () => <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">x</div>',
          errors: [{ messageId: 'preferCard' }],
        },
        {
          code: 'const A = () => <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">x</section>',
          errors: [{ messageId: 'preferCard' }],
        },
        // Also catches the braced-string form.
        {
          code: 'const A = () => <div className={"rounded-xl border border-neutral-200 bg-white p-4 shadow-card"}>x</div>',
          errors: [{ messageId: 'preferCard' }],
        },
      ],
    })
  })
})
