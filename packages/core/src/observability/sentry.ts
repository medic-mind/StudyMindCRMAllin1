// Thin Sentry adapter. Webhook routes, Inngest functions, and tRPC error
// formatters wrap their bodies with `withSentry` so any thrown error is
// captured before it propagates. CLAUDE.md §25.
//
// We do not import @sentry/nextjs here — packages/core stays runtime-agnostic.
// The host app (web or worker) installs Sentry; if no global handler is
// registered, this becomes a no-op so unit tests never need a Sentry mock.

interface SentryLike {
  captureException: (e: unknown, hint?: { tags?: Record<string, string> }) => void
}

function getSentry(): SentryLike | null {
  const g = globalThis as unknown as { Sentry?: SentryLike }
  return g.Sentry ?? null
}

/** Allow the host app to register the Sentry SDK once for `withSentry` to use. */
export function registerSentry(sdk: SentryLike): void {
  ;(globalThis as unknown as { Sentry?: SentryLike }).Sentry = sdk
}

/**
 * Wraps an async function: any thrown error is captured to Sentry (when
 * registered) and re-thrown unchanged. Optional `tags` are attached to the
 * Sentry event for slicing in the UI.
 */
export function withSentry<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  tags: Record<string, string> = {},
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    try {
      return await fn(...args)
    } catch (err) {
      const sentry = getSentry()
      sentry?.captureException(err, { tags })
      throw err
    }
  }
}
