// Custom ESLint rule: every static event-name string passed to
// `inngest.send({ name })`, `db.interaction.create({ data: { type } })`,
// or `writeAuditLogEntry({ action })` must exist in
// `packages/core/src/events/registry.ts`.
//
// Dynamic strings (template literals, identifiers) are skipped — review
// catches those, and the disable directive
//   // eslint-disable-next-line studymind/registered-event-names
// is the documented escape hatch (CLAUDE.md §45).
//
// CLAUDE.md §45.1.

const path = require('node:path')
const fs = require('node:fs')

let cachedRegistry = null

function loadRegistry() {
  if (cachedRegistry) return cachedRegistry
  // The registry is a TS file with three string-literal arrays. We parse
  // them with a regex rather than depending on ts-node here; ESLint runs
  // in the Node process and we don't want a TS compile pass per-rule.
  const registryPath = path.resolve(
    __dirname,
    '..',
    '..',
    'packages',
    'core',
    'src',
    'events',
    'registry.ts',
  )
  const src = fs.readFileSync(registryPath, 'utf8')

  function extract(arrayName) {
    const re = new RegExp(`export const ${arrayName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`)
    const m = re.exec(src)
    if (!m) return new Set()
    const body = m[1]
    const items = []
    const itemRe = /['"]([^'"\n]+)['"]/g
    let mm
    while ((mm = itemRe.exec(body)) !== null) {
      items.push(mm[1])
    }
    return new Set(items)
  }

  cachedRegistry = {
    audit: extract('EVENT_NAMES'),
    inngest: extract('INNGEST_EVENT_NAMES'),
    interaction: extract('INTERACTION_TYPES'),
  }
  return cachedRegistry
}

function literalString(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  // Template literal with no expressions is effectively a string literal.
  if (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked
  }
  return null
}

function findProperty(objExpr, key) {
  if (!objExpr || objExpr.type !== 'ObjectExpression') return null
  for (const p of objExpr.properties) {
    if (
      p.type === 'Property' &&
      ((p.key.type === 'Identifier' && p.key.name === key) ||
        (p.key.type === 'Literal' && p.key.value === key))
    ) {
      return p.value
    }
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reject inngest.send / Interaction.create / writeAuditLogEntry calls whose static name string is not in packages/core/src/events/registry.ts.',
    },
    messages: {
      unregisteredAudit:
        "Audit action '{{ name }}' is not in EVENT_NAMES (packages/core/src/events/registry.ts). Register it or fix the typo. CLAUDE.md §45.",
      unregisteredInngest:
        "Inngest event name '{{ name }}' is not in INNGEST_EVENT_NAMES. Register it. CLAUDE.md §45.",
      unregisteredInteraction:
        "Interaction.type '{{ name }}' is not in INTERACTION_TYPES. Register it or fix the typo. CLAUDE.md §45.",
    },
    schema: [],
  },
  create(context) {
    const registry = loadRegistry()

    function check(node, name, kind) {
      const set =
        kind === 'audit'
          ? registry.audit
          : kind === 'inngest'
            ? registry.inngest
            : registry.interaction
      if (set.has(name)) return
      const messageId =
        kind === 'audit'
          ? 'unregisteredAudit'
          : kind === 'inngest'
            ? 'unregisteredInngest'
            : 'unregisteredInteraction'
      context.report({ node, messageId, data: { name } })
    }

    return {
      CallExpression(node) {
        const callee = node.callee
        if (!callee) return

        // inngest.send({ name }) — match `<id>.send` to be tolerant of
        // `inngest.send`, `client.send`, etc.
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'send' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'inngest'
        ) {
          const arg = node.arguments[0]
          if (arg && arg.type === 'ObjectExpression') {
            const nameNode = findProperty(arg, 'name')
            const lit = literalString(nameNode)
            if (lit) check(nameNode, lit, 'inngest')
          }
          return
        }

        // writeAuditLogEntry(db, { action })
        if (
          (callee.type === 'Identifier' && callee.name === 'writeAuditLogEntry') ||
          (callee.type === 'MemberExpression' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'writeAuditLogEntry')
        ) {
          // First arg may be the db client; second arg is the entry. Accept either form.
          const candidate = node.arguments.find(
            (a) => a && a.type === 'ObjectExpression' && findProperty(a, 'action'),
          )
          if (candidate) {
            const actionNode = findProperty(candidate, 'action')
            const lit = literalString(actionNode)
            if (lit) check(actionNode, lit, 'audit')
          }
          return
        }

        // db.interaction.create({ data: { type } }) or
        // tx.interaction.create({ data: { type } })
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'create' &&
          callee.object.type === 'MemberExpression' &&
          callee.object.property.type === 'Identifier' &&
          callee.object.property.name === 'interaction'
        ) {
          const arg = node.arguments[0]
          if (arg && arg.type === 'ObjectExpression') {
            const dataNode = findProperty(arg, 'data')
            if (dataNode && dataNode.type === 'ObjectExpression') {
              const typeNode = findProperty(dataNode, 'type')
              const lit = literalString(typeNode)
              if (lit) check(typeNode, lit, 'interaction')
            }
          }
        }
      },
    }
  },
}
