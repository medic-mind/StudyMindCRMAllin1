// Custom ESLint rule: flag a hand-rolled "plain white bordered panel" in the
// app UI and steer it to the shared <Card> primitive (CLAUDE.md §0.5 / §4).
//
// The design system has ONE surface primitive — `<Card>` (apps/web/components/
// ui/card.tsx) renders `rounded-xl border border-neutral-200 bg-white
// shadow-card`. Re-hand-rolling that string on a <div>/<section> is the exact
// drift the card sweep removed; this rule stops it creeping back.
//
// Deliberately conservative to avoid false positives on the legitimate
// non-Card surfaces that remain (verified against the tree when landed):
//   - Only `<div>` / `<section>` elements (never <li>/<form>/<Link>/<header>/
//     <nav>, where <Card> — a plain div — would drop list/form/link semantics).
//   - Only a *static string* className (template literals / dynamic classNames
//     are skipped — e.g. the accent-bordered draggable BoardCard).
//   - Requires the full plain-panel signature: `shadow-card` + `border-neutral-200`
//     + a solid `bg-white` (translucent `bg-white/NN` is skipped).
//   - Skips `inline-flex` (segmented / tablist toggle controls) and `border-l-`
//     (accent-bordered cards) — those are intentionally not Card surfaces.
//
// Scope is applied in eslint.config.mjs: apps/web/app/(app)/** only.

const PANEL_ELEMENTS = new Set(['div', 'section'])

// `shadow-card` but not `shadow-card-hover`.
const HAS_SHADOW_CARD = /shadow-card(?!-)/
const HAS_BORDER_NEUTRAL = /border-neutral-200/
// Solid white only — exclude translucent `bg-white/90` etc.
const HAS_SOLID_WHITE = /bg-white(?![/\w])/
const IS_INLINE_CONTROL = /inline-flex/
const HAS_ACCENT_BORDER = /border-l-/

function isHandRolledPanel(className) {
  return (
    HAS_SHADOW_CARD.test(className) &&
    HAS_BORDER_NEUTRAL.test(className) &&
    HAS_SOLID_WHITE.test(className) &&
    !IS_INLINE_CONTROL.test(className) &&
    !HAS_ACCENT_BORDER.test(className)
  )
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Use the shared <Card> primitive instead of a hand-rolled bordered white panel.',
    },
    schema: [],
    messages: {
      preferCard:
        'Hand-rolled bordered white panel. Use the shared <Card> primitive from ' +
        "'@/components/ui/card' instead (CLAUDE.md §0.5). If this element is " +
        'genuinely not a Card surface, disable this line with a reason.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name?.type !== 'JSXIdentifier') return
        if (!PANEL_ELEMENTS.has(node.name.name)) return

        const classNameAttr = node.attributes.find(
          (attr) =>
            attr.type === 'JSXAttribute' &&
            attr.name?.type === 'JSXIdentifier' &&
            attr.name.name === 'className',
        )
        if (!classNameAttr) return

        // Static string only. `className="…"` → Literal; `className={'…'}` →
        // JSXExpressionContainer > Literal. Template literals / identifiers are
        // dynamic and skipped.
        const value = classNameAttr.value
        let literal = null
        if (value?.type === 'Literal' && typeof value.value === 'string') {
          literal = value
        } else if (
          value?.type === 'JSXExpressionContainer' &&
          value.expression?.type === 'Literal' &&
          typeof value.expression.value === 'string'
        ) {
          literal = value.expression
        }
        if (!literal) return

        if (isHandRolledPanel(literal.value)) {
          context.report({ node: literal, messageId: 'preferCard' })
        }
      },
    }
  },
}
