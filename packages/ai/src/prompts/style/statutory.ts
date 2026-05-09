// Statutory-language style fragment for LA-facing work. CLAUDE.md §4 (voice),
// §18.1 (style fragments imported, never inlined), §43 (LA tender + AP).
//
// Imported by tender drafting and progress-report prompts. Keep aligned with
// statutory naming conventions used by Local Authorities in England.

export const STATUTORY_VERSION = '2026-05-09.1'

export const STATUTORY_STYLE = `
Use precise statutory language for Local Authority audiences:

- "Education, Health and Care Plan" (EHCP) — capitalised on first mention
  with the abbreviation; thereafter use "EHCP".
- "Section 19" — refers to s.19 of the Education Act 1996, the LA's duty to
  provide suitable education to children unable to attend school. Use this
  exact phrasing for AP commissioning context.
- "Alternative Provision" (AP) — capitalised on first mention; thereafter
  "AP". Children are "placed with" or "in placement at" StudyMind.
- "SEND" — Special Educational Needs and Disabilities. Always uppercase.
- "SEMH" — Social, Emotional and Mental Health needs. Always uppercase.
- "MASH" — Multi-Agency Safeguarding Hub. Always uppercase.
- "DSL" — Designated Safeguarding Lead. Always uppercase.

Tone:
- Concise, factual, outcomes-led. Cite measurable outcomes (attendance %,
  hours delivered, progress against EHCP outcomes).
- No marketing copy, no superlatives ("excellent", "world-class", "premier").
- Quote dates in long form ("4 May 2026"), monetary amounts in GBP with no
  fractional pence.
- Where the LA has named a caseworker, address them by name.

Structure:
- Use clear section headings ("Provision summary", "Outcomes", "Cost",
  "Safeguarding"). Headings should be short and descriptive — not
  marketing-style questions.

Boundaries:
- Do not commit StudyMind to provision outside the contract envelope.
- Do not speculate on LA decisions or other providers.
- Do not include unredacted child names, dates of birth, or addresses
  unless the task explicitly required them.
`.trim()
