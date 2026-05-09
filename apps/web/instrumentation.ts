// Next.js 15 instrumentation hook. Picked up automatically when present.
// Loads Sentry on the right runtime, and (Node only) initialises OpenTelemetry.
// CLAUDE.md §25 (observability).

export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    await import('./sentry.server.config')
    // OpenTelemetry SDK init lives in core/observability/trace so the worker
    // (Inngest serve) and the web both register the same providers.
    const { initTracing } = await import('@studymind/core/observability/trace')
    initTracing()
  }
  if (process.env['NEXT_RUNTIME'] === 'edge') {
    await import('./sentry.edge.config')
  }
}
