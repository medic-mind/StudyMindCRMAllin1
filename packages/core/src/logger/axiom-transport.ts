// Axiom HTTP ingest transport for pino. CLAUDE.md §25.
//
// We write a small custom transport instead of pulling in pino-axiom so we
// own the failure mode (drop-on-error, never crash the request) and so the
// transport works in serverless runtimes without a worker thread.
//
// Wire-up: see packages/core/src/logger/index.ts. The transport is a plain
// async function that the logger calls per record; we batch and POST.

const FLUSH_INTERVAL_MS = 1000
const MAX_BATCH = 100

interface AxiomConfig {
  token: string
  dataset: string
  endpoint?: string // default ingest.axiom.co
}

interface AxiomBatcher {
  push: (record: Record<string, unknown>) => void
  flush: () => Promise<void>
}

export function createAxiomBatcher(cfg: AxiomConfig): AxiomBatcher {
  const endpoint = cfg.endpoint ?? 'https://api.axiom.co'
  const url = `${endpoint}/v1/datasets/${encodeURIComponent(cfg.dataset)}/ingest`
  const queue: Record<string, unknown>[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  async function flushNow(): Promise<void> {
    if (queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(batch),
      })
    } catch {
      // Silent drop — Axiom outage must not bring down request handling.
      // Sentry will still see exceptions; access logs are best-effort.
    }
  }

  function schedule(): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void flushNow()
    }, FLUSH_INTERVAL_MS)
  }

  return {
    push(record) {
      queue.push(record)
      if (queue.length >= MAX_BATCH) {
        void flushNow()
      } else {
        schedule()
      }
    },
    flush: flushNow,
  }
}
