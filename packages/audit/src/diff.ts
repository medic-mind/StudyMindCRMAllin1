// Minimal JSON diff used by the audit writer. We persist `before` and `after`
// alongside in AuditLogEntry; the diff is computed on demand for display.

export interface JsonDiffEntry {
  path: string
  before: unknown
  after: unknown
}

export function jsonDiff(before: unknown, after: unknown): JsonDiffEntry[] {
  const out: JsonDiffEntry[] = []
  walk('', before, after, out)
  return out
}

function walk(path: string, a: unknown, b: unknown, out: JsonDiffEntry[]): void {
  if (Object.is(a, b)) return
  if (!isObject(a) || !isObject(b)) {
    out.push({ path: path || '$', before: a, after: b })
    return
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    walk(path ? `${path}.${key}` : key, a[key], b[key], out)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
