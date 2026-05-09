# Runbook: Lighthouse CI budgets

CLAUDE.md §26 sets per-route performance budgets for the critical surfaces — Inbox, Family, and Finance. The `lighthouse.yml` workflow enforces them via Lighthouse CI on every push to `main` and on any PR labelled `lighthouse`.

## What is enforced

| Metric | Budget |
| --- | --- |
| Performance score | >= 0.90 |
| Accessibility score | >= 0.95 |
| Largest Contentful Paint | < 2000 ms |

Targeted routes: `/`, `/contacts`, `/inbox`, `/finance`, `/contacts/families/test-family`. The base URL is `vars.LIGHTHOUSE_BASE_URL` (defaults to staging). The deterministic test family must exist in the target environment; staging seed creates `test-family`.

## When the budget fires

1. The CI run for the merging PR fails. Do NOT label `lighthouse-skip`; investigate.
2. Open the uploaded HTML report from the workflow artefact. Scroll to the offending metric.
3. Common causes:
   - A new third-party script added without `defer` or `async`.
   - A large client component shipped to a route that should be RSC.
   - An image landed without `next/image` width/height (forces CLS).
   - A blocking font request (move to `next/font`).
4. Patch the cause, not the budget. Lowering the budget requires an ADR.

## Owner

The frontend lead owns the Lighthouse pipeline. Performance regressions are triaged at the weekly review (CLAUDE.md §33).

## Local repro

```bash
BASE_URL=http://localhost:3000 pnpm exec lhci autorun --config=./lighthouserc.json
```

Run with `pnpm dev` already running. The desktop preset and 3G throttling profile in `lighthouserc.json` match CI.
