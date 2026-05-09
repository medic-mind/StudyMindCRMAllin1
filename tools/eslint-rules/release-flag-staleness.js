// Custom ESLint rule: a release flag is stale if its `firstShippedAt` was
// more than 30 days ago. Stale release flags should be removed (CLAUDE.md
// §31).
//
// The rule scans the FLAGS object literal in
// `packages/core/src/flags/registry.ts`. Entries without `firstShippedAt`
// are skipped — that's the documented opt-out for flags that have not
// shipped yet, or where dating doesn't apply (operational kill-switches
// are exempt entirely because they're long-lived).
//
// Today is taken from `process.env.STALE_FLAG_NOW` (ISO date) when set, so
// CI on a frozen-in-time fixture is deterministic.

const STALE_AFTER_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

function today() {
  const override = process.env.STALE_FLAG_NOW
  if (override) {
    const t = Date.parse(override)
    if (!Number.isNaN(t)) return new Date(t)
  }
  return new Date()
}

/**
 * Walk an ObjectExpression and return entries of the form
 *   [keyText, valueObjectExpression]
 * for every flag in the FLAGS literal.
 */
function flagEntries(objExpr) {
  if (!objExpr || objExpr.type !== 'ObjectExpression') return []
  const out = []
  for (const p of objExpr.properties) {
    if (p.type !== 'Property') continue
    if (p.value.type !== 'ObjectExpression') continue
    let keyText
    if (p.key.type === 'Literal') keyText = String(p.key.value)
    else if (p.key.type === 'Identifier') keyText = p.key.name
    else continue
    out.push([keyText, p.value, p])
  }
  return out
}

function findProperty(objExpr, name) {
  if (!objExpr || objExpr.type !== 'ObjectExpression') return null
  for (const p of objExpr.properties) {
    if (p.type !== 'Property') continue
    if (
      (p.key.type === 'Identifier' && p.key.name === name) ||
      (p.key.type === 'Literal' && p.key.value === name)
    ) {
      return p.value
    }
  }
  return null
}

function literalString(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Reject release flags whose firstShippedAt is more than 30 days ago. CLAUDE.md §31.',
    },
    messages: {
      stale:
        "Release flag '{{ name }}' shipped on {{ firstShippedAt }} ({{ days }} days ago) and should be removed. CLAUDE.md §31 — stale release flags are reported by CI after 30 days.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (!/packages[\\/]core[\\/]src[\\/]flags[\\/]registry\.ts$/.test(filename)) {
      // The rule only applies to the registry file itself; everywhere else
      // it is a no-op so it can stay enabled globally without false positives.
      return {}
    }

    const now = today()

    return {
      VariableDeclarator(node) {
        if (!node.id || node.id.name !== 'FLAGS') return
        // The init may be a `<expr> as const satisfies …`. Walk to the literal.
        let init = node.init
        if (!init) return
        // Handle `<expr> as const satisfies …` shapes.
        while (init && init.type !== 'ObjectExpression' && (init.expression || init.left)) {
          init = init.expression ?? init.left
        }
        if (!init || init.type !== 'ObjectExpression') return

        for (const [name, val, propNode] of flagEntries(init)) {
          const kindNode = findProperty(val, 'kind')
          const kind = literalString(kindNode)
          if (kind !== 'release') continue
          const shippedNode = findProperty(val, 'firstShippedAt')
          const shipped = literalString(shippedNode)
          if (!shipped) continue // documented opt-out
          const t = Date.parse(shipped)
          if (Number.isNaN(t)) continue
          const ageDays = Math.floor((now.getTime() - t) / MS_PER_DAY)
          if (ageDays > STALE_AFTER_DAYS) {
            context.report({
              node: propNode,
              messageId: 'stale',
              data: {
                name,
                firstShippedAt: shipped,
                days: String(ageDays),
              },
            })
          }
        }
      },
    }
  },
}
