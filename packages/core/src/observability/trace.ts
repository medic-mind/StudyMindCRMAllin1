// OpenTelemetry adapter. Replaced with a real SDK init in Chunk 3.
// Today this is a stub so the web instrumentation hook can import it
// safely in environments without a tracer configured.
//
// CLAUDE.md §17 / §25.

export function initTracing(): void {
  // Real implementation lives in chunk 3 (OpenTelemetry SDK).
}

export async function withSpan<T>(
  _name: string,
  fn: () => Promise<T>,
  _attrs: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  return fn()
}

/** Returns the active OTel trace id when available, or undefined. */
export function currentTraceId(): string | undefined {
  return undefined
}
