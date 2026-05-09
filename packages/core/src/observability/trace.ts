// OpenTelemetry adapter. CLAUDE.md §17, §25.
//
// initTracing() registers a Node SDK with OTLP export when the
// OTEL_EXPORTER_OTLP_ENDPOINT env var is set; otherwise it is a no-op so
// local dev and tests stay quiet. The web app calls initTracing() from
// instrumentation.ts on the Node runtime; the worker also calls it on boot.
//
// withSpan(name, fn, attrs) creates a child span, records exception on
// throw, sets attributes (provider, endpoint, entity_id per §17), and
// returns whatever fn returns. Used in webhook handlers and Inngest steps
// to tag work with provider context.

import { SpanStatusCode, trace, type Span } from '@opentelemetry/api'

let initialised = false

export function initTracing(): void {
  if (initialised) return
  if (!process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) return
  initialised = true
  try {
    // Lazy require so the SDK is only loaded when actually configured. The
    // SDK pulls in many transitive deps; we don't want them in test paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeSDK } = require('@opentelemetry/sdk-node')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node')
    const sdk = new NodeSDK({
      instrumentations: [getNodeAutoInstrumentations()],
    })
    sdk.start()
  } catch {
    // Tracing must never crash the process. Sentry will still capture errors.
  }
}

const tracer = trace.getTracer('studymind-crm', '0.1.0')

type Attrs = Record<string, string | number | boolean | undefined>

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attrs: Attrs = {},
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined) span.setAttribute(k, v)
      }
      return await fn(span)
    } catch (err) {
      span.recordException(err as Error)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw err
    } finally {
      span.end()
    }
  })
}

/** Returns the active OTel trace id (32-hex), or undefined when not in a span. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan()
  if (!span) return undefined
  const ctx = span.spanContext()
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return undefined
  return ctx.traceId
}
