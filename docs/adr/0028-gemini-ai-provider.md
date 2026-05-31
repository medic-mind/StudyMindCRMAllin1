# ADR 0028 — Gemini as the default AI provider (switchable)

- Status: Accepted
- Date: 2026-05-31
- Supersedes: none (revises the §3/§18 "OpenAI for everything AI" decision)
- Related: ADR 0023 (lead classification), CLAUDE.md §3, §18, §32

## Context

Every AI feature on the site runs through `packages/ai` behind three functions:
`runStructured` (classification/extraction), `runDraft` (prose drafts), and
`transcribeAudio` (Aircall fallback). Until now all three called OpenAI
(`gpt-4o`, `gpt-4o-mini`, `whisper-1`). The product owner asked to move all AI
to Google Gemini, keeping the ability to choose models and revert.

Because the whole surface funnels through one package and the model is a typed
literal at the call sites, the provider can be swapped centrally without
touching the ~8 call sites or any prompt.

## Decision

Introduce a **provider seam** in `packages/ai/src/clients/`:

- `models.ts` — single source of truth for provider + model resolution. Two
  quality tiers (`mini`, `standard`); the legacy literals (`gpt-4o-mini` /
  `gpt-4o`) passed by call sites are treated as **tier hints** (`tierOf`), so no
  call site changed.
- `gemini.ts` — singleton `@google/genai` client (new dependency).
- `provider.ts` — `generate()` dispatches the network call to Gemini or OpenAI;
  the three public clients keep ALL cross-cutting logic (budget guardrail, Zod
  validation, structured logging, drift sampling).

**Defaults (the requested behaviour):**

- **Gemini is preferred** as soon as `GEMINI_API_KEY` is set — adding the key
  flips the site to Gemini with no code change. `AI_PROVIDER=gemini|openai` pins
  it explicitly; with only `OPENAI_API_KEY` present the site keeps working on
  OpenAI (instant revert).
- **Flash for most**: both tiers default to `gemini-2.5-flash`. Either tier is
  independently overridable by env (`GEMINI_MODEL_MINI`,
  `GEMINI_MODEL_STANDARD`, `GEMINI_MODEL_TRANSCRIBE`) so the quality tier can be
  promoted to `gemini-2.5-pro` for drafts without a deploy.
- **Transcription moves to Gemini** multimodal (inline audio bytes + a
  transcribe prompt). Whisper remains the OpenAI-path implementation.

**Structured-output strategy.** OpenAI uses strict `json_schema` response
format; Gemini uses `responseMimeType: application/json` with the JSON schema
embedded in the system instruction (we deliberately avoid Gemini's
`responseSchema`, whose dialect differs from JSON Schema). In both cases the
**caller's Zod schema is the authoritative validator** — we fail closed on a
parse/shape mismatch exactly as before, so output quality is gated identically
regardless of provider. A leading ```json fence from Gemini is stripped before
`JSON.parse`.

## Alternatives rejected

- **Replace OpenAI entirely.** Rejected for now — a switchable seam gives an
  instant fallback if a task regresses on Gemini and lets us A/B. OpenAI can be
  deleted in a later ADR once Gemini is proven across every task.
- **Per-call-site model changes.** Rejected — the tier-hint mapping keeps the
  change to one package and zero call-site churn.
- **Gemini `responseSchema`.** Rejected as the contract — schema-in-prompt +
  Zod validation is portable and already our fail-closed guarantee.

## Consequences

- New dependency `@google/genai`; new env: `AI_PROVIDER`, `GEMINI_API_KEY`,
  `GEMINI_MODEL_*`, `OPENAI_MODEL_*`. Pricing table gains Gemini rows
  (advisory; refresh quarterly).
- `StructuredModel` / `DraftModel` types are retained as legacy aliases so no
  caller breaks.
- Cost guardrails, drift sampling, restricted-contact guard, and the eval
  harness are unchanged; live evals now run with either provider key.
- Follow-ups: tune Gemini pricing against real usage; consider per-task tier
  overrides in the DB; once Gemini is proven, an ADR to drop OpenAI.
