// Crib content that does NOT live in its defaults.json (ADR 0040), kept as
// a sibling module so crib-data.json stays a byte-for-byte copy of the
// Crib's defaults.json. sections.ts merges these in:
//
// - COMMON_SCENARIOS — extracted verbatim from the Crib frontend's
//   hardcoded SCENARIOS constant (public/script.js).
// - FOUNDER_PEOPLE — the founders, documented in the Crib repo's CLAUDE.md
//   §3 (brand architecture) but absent from its defaults.json people list.

import type { KnowledgeValue } from './types'

export const FOUNDER_PEOPLE: KnowledgeValue = [
  {
    name: 'Mohil',
    role: 'Co-founder',
    handles:
      'Sits across MedicMind and OxbridgeMind with Kunal — brand architecture and direction.',
  },
  {
    name: 'Kunal',
    role: 'Co-founder',
    handles:
      'Sits across MedicMind and OxbridgeMind with Mohil. Runs the master classes included with the Platinum Full Application Scheme.',
  },
]

export const COMMON_SCENARIOS: KnowledgeValue = [
  {
    title: 'International parent, first call',
    tone: 'high-touch',
    guidance: [
      "Confirm time-zone — many international parents call across odd hours.",
      "Ask which UK city they're considering — relevant for camps, in-person live days, MMI.",
      'Standard Visitor Visa applies for camps; we can issue a booking confirmation letter.',
      'GBP pricing — quote in £, mention USD equivalents on TeenLife / Oxford Summer Schools listings.',
      'Pair with: 2-week camps (margin-friendly + visa-justified flight).',
    ],
  },
  {
    title: 'Anxious teen reluctant to engage',
    tone: 'soft',
    guidance: [
      'Acknowledge — most teens hate the idea of "more tutoring".',
      'Position the tutor as a recent grad, not another teacher.',
      'First session = strategy chat, not questions. Lower stakes.',
      '2-hour trial guarantee removes the commitment fear.',
      'If they refuse online, mention WhatsApp group as low-friction async support.',
    ],
  },
  {
    title: 'Family already using another provider',
    tone: 'curious',
    guidance: [
      'Ask what subject and which provider — qualifies the lead.',
      'If A-level generalist: not our market, suggest pairing instead of switching.',
      "If UCAT / Oxbridge / specialist: ask what they're scoring; offer a 2-hour trial.",
      "Don't bash the other provider — frame ours as additive.",
      'Free Live Day eligibility is a low-friction add even if they keep their tutor.',
    ],
  },
  {
    title: 'Y12 student, just starting medicine prep',
    tone: 'consultative',
    guidance: [
      'Confirm: UCAT in summer of Y12→Y13, applications in autumn Y13.',
      'Start: 20-30 UCAT hours over the spring + summer.',
      'Add work experience push — GP / hospice exposure is the single biggest UCAS differentiator.',
      'Upsell path: Full Application Scheme (Bronze) covers UCAT + interview + PS + Live Day + Online Course.',
      "Confirm Kunal's master classes for Platinum applicants (3h group sessions over summer).",
    ],
  },
  {
    title: 'Y13 student late to Oxbridge prep',
    tone: 'urgent',
    guidance: [
      'Confirm: UCAS deadline 15 October. Registration for UAT-UK mid-September.',
      'Triage: which test is most urgent — TMUA/ESAT/TARA/LNAT?',
      'Push: 20-hour intensive over 6 weeks minimum.',
      'Personal Statement: 10 hour pack, can run parallel.',
      'Set expectations: Oxbridge offer rates are low — we maximise but cannot guarantee.',
    ],
  },
  {
    title: 'Parent dithering on price',
    tone: 'reassuring',
    guidance: [
      'Acknowledge the cost.',
      'Frame against UCAS application (£127) + UCAT (£200) + uni fees (years of £9,250) — prep is the cheapest part of the chain.',
      'Mention 12-month GoCardless installment plan (3% fee, no interest).',
      'Offer complimentary hours from the ladder per Section 9 — not £-discount.',
      "Always confirm Becca's current offer before quoting a specific number.",
    ],
  },
  {
    title: 'Repeat customer asking about next product',
    tone: 'warm',
    guidance: [
      'Recognise the relationship — call out the previous tutor by name.',
      'Cross-sell from the Natural pairings list on the product page.',
      'Returning customers qualify for complimentary hours sooner.',
      'Ideal upsell path: hourly → Full Application Scheme bundle.',
    ],
  },
  {
    title: 'Parent enquiring about a Career Camp',
    tone: 'consultative',
    guidance: [
      'Confirm age (15-18, some flex — escalate edge cases to Madeleine).',
      'Confirm residential or day — DoE Gold needs residential.',
      'Suggest pairings — Law + Criminology, Medicine + Psychology, etc.',
      'Confirm dates: 7 weeks Mon-Fri Jun 29 - Aug 14, alternating Week A / Week B.',
      'Lead with safety: 1:10 guardian ratio, 24/7 Ramsay Hall security.',
      'VIP enquiry → tag Aashir. Already booked → Madeleine + Fritzie. Standard → handle from this CRIB.',
    ],
  },
]
