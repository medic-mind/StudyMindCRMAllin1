// Custom ESLint rule: any tRPC mutation procedure that performs a Prisma write
// on a sensitive model (Contact, Family, FinancialAccount, Interaction,
// SafeguardingFlag, ...) MUST call `ctx.audit(...)` before returning.
//
// CLAUDE.md §27 mandates audit context on every write to those rows. The
// runtime check in `auditedProcedure` is the backstop; this rule fails CI
// before the bug ships.
//
// Scope: files under `apps/web/app/api/trpc/routers/**`.
// Heuristic: walks every `.mutation(fn)` call and inspects `fn`'s body for
// (a) sensitive Prisma writes and (b) `ctx.audit(...)` calls.

const SENSITIVE_MODELS = new Set([
  'contact',
  'family',
  'familyMember',
  'financialAccount',
  'interaction',
  'safeguardingFlag',
  'refundIntent',
  'encryptedField',
])

const SENSITIVE_VERBS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
])

function walkCalls(root, cb) {
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (node.type === 'CallExpression') cb(node)
    for (const key of Object.keys(node)) {
      // Skip parent pointers and other circular metadata.
      if (key === 'parent' || key === 'loc' || key === 'range') continue
      const v = node[key]
      if (!v) continue
      if (Array.isArray(v)) {
        for (const it of v) if (it && typeof it === 'object' && it.type) stack.push(it)
      } else if (typeof v === 'object' && v.type) {
        stack.push(v)
      }
    }
  }
}

function inspect(fn) {
  let hasAuditCall = false
  let hasSensitiveWrite = false

  walkCalls(fn.body, (call) => {
    const callee = call.callee
    if (!callee || callee.type !== 'MemberExpression') return

    // ctx.audit(...)
    if (
      callee.object.type === 'Identifier' &&
      callee.object.name === 'ctx' &&
      callee.property.type === 'Identifier' &&
      callee.property.name === 'audit'
    ) {
      hasAuditCall = true
      return
    }

    // <prefix>.<model>.<verb>(...)
    if (callee.property.type !== 'Identifier') return
    const verb = callee.property.name
    if (!SENSITIVE_VERBS.has(verb)) return
    const mid = callee.object
    if (mid.type !== 'MemberExpression' || mid.property.type !== 'Identifier') return
    if (!SENSITIVE_MODELS.has(mid.property.name)) return

    // We do not require the leftmost name to be `db` — `tx.<model>.<verb>` from
    // a Prisma `$transaction` callback is also a sensitive write.
    hasSensitiveWrite = true
  })

  return { hasAuditCall, hasSensitiveWrite }
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'tRPC mutation procedures that write to sensitive models must call ctx.audit(...).',
    },
    messages: {
      missingAudit:
        'tRPC mutation writes to a sensitive model without calling ctx.audit(...). See CLAUDE.md §20, §27.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (!/[\\/]app[\\/]api[\\/]trpc[\\/]routers[\\/]/.test(filename)) return {}

    return {
      CallExpression(node) {
        const callee = node.callee
        if (!callee || callee.type !== 'MemberExpression') return
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'mutation') return
        const fnArg = node.arguments[0]
        if (
          !fnArg ||
          (fnArg.type !== 'ArrowFunctionExpression' && fnArg.type !== 'FunctionExpression')
        ) {
          return
        }

        const { hasAuditCall, hasSensitiveWrite } = inspect(fnArg)
        if (hasSensitiveWrite && !hasAuditCall) {
          context.report({ node, messageId: 'missingAudit' })
        }
      },
    }
  },
}
