// Builds the Aircall analytics report as a PDF (CLAUDE.md §10). One or more
// A4 pages of plain text via the first-party, dependency-free PDF writer
// (CLAUDE.md §3 — no new deps). Covers the headline KPIs, the peak-times
// breakdown (configured windows + peak vs off-peak), and the top contacts so
// a manager can file or share the period's call performance.

import { renderPaginatedTextDocumentPdf, type PdfTextBlock } from '../email/pdf/pdf-writer'

export interface AircallPdfKpis {
  total: number
  answered: number
  answeredRate: number
  voicemails: number
  missed: number
  inbound: number
  outbound: number
  avgDurationSec: number
  totalTalkSec: number
}

export interface AircallPdfPeakWindow {
  name: string
  season: string
  days: string
  hours: string
  year: string
  calls: number
  answered: number
}

export interface AircallPdfPeak {
  configured: boolean
  windowCount: number
  peakCalls: number
  offPeakCalls: number
  peakShare: number
  peakAnsweredRate: number
  offPeakAnsweredRate: number
  peakTalkSec: number
  busiestLabel: string | null
  windows: ReadonlyArray<AircallPdfPeakWindow>
}

export interface AircallPdfInput {
  generatedAt: Date
  period: { from: Date; to: Date }
  directionLabel: string
  providerLabel: string
  kpis: AircallPdfKpis
  peak: AircallPdfPeak
  topContacts: ReadonlyArray<{ name: string; kind: string | null; count: number }>
}

export const AIRCALL_PDF_FILENAME = 'StudyMind-CRM-aircall-report.pdf'

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(d)
}

function fmtDateTime(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rem = s % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${String(rem).padStart(2, '0')}s`
}

function fmtPct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`
}

/** A "Label: value" line as a single block (bold label is not supported inline
 * by the writer, so we keep the whole line at body weight for alignment). */
function kv(label: string, value: string, spacingBefore = 2): PdfTextBlock {
  return { text: `${label}:  ${value}`, size: 11, spacingBefore }
}

export function buildAircallReportPdf(input: AircallPdfInput): Buffer {
  const { kpis, peak } = input
  const blocks: PdfTextBlock[] = [
    { text: 'StudyMind CRM', bold: true, size: 22 },
    { text: 'Aircall call report', size: 13, spacingBefore: 4 },
    {
      text: `${fmtDate(input.period.from)} – ${fmtDate(input.period.to)}  ·  ${input.directionLabel}  ·  ${input.providerLabel}`,
      size: 11,
      spacingBefore: 6,
    },
    { text: `Generated ${fmtDateTime(input.generatedAt)}`, size: 9, spacingBefore: 2 },

    { text: 'Headline', bold: true, size: 13, spacingBefore: 22 },
    kv('Total calls', String(kpis.total), 8),
    kv('Answered', `${kpis.answered}  (${fmtPct(kpis.answeredRate)})`),
    kv('Voicemails', String(kpis.voicemails)),
    kv('Missed', String(kpis.missed)),
    kv('Inbound / outbound', `${kpis.inbound} / ${kpis.outbound}`),
    kv('Average call duration', fmtDuration(kpis.avgDurationSec)),
    kv('Total talk time', fmtDuration(kpis.totalTalkSec)),

    { text: 'Peak times', bold: true, size: 13, spacingBefore: 22 },
  ]

  if (!peak.configured) {
    blocks.push({
      text: 'No peak windows configured. Define peak days and hours on the Aircall report to see how calls land inside vs outside your peak times.',
      size: 11,
      spacingBefore: 8,
    })
  } else {
    blocks.push(
      kv('Peak windows', String(peak.windowCount), 8),
      kv(
        'Calls in peak',
        `${peak.peakCalls}  (${fmtPct(peak.peakShare)} of all calls)`,
      ),
      kv('Calls off-peak', String(peak.offPeakCalls)),
      kv('Answered rate — peak', fmtPct(peak.peakAnsweredRate)),
      kv('Answered rate — off-peak', fmtPct(peak.offPeakAnsweredRate)),
      kv('Talk time in peak', fmtDuration(peak.peakTalkSec)),
      kv('Busiest peak slot', peak.busiestLabel ?? '—'),
    )
    blocks.push({ text: 'Configured windows', bold: true, size: 11, spacingBefore: 16 })
    for (const w of peak.windows) {
      blocks.push({ text: w.name, bold: true, size: 11, spacingBefore: 8 })
      blocks.push({
        text: `${w.season}  ·  ${w.days}  ·  ${w.hours}  ·  ${w.year}`,
        size: 10,
        spacingBefore: 1,
      })
      blocks.push({
        text: `${w.calls} call${w.calls === 1 ? '' : 's'}, ${w.answered} answered`,
        size: 10,
        spacingBefore: 1,
      })
    }
  }

  blocks.push({ text: 'Top contacts by call volume', bold: true, size: 13, spacingBefore: 22 })
  if (input.topContacts.length === 0) {
    blocks.push({ text: 'No calls against a known contact in this period.', size: 11, spacingBefore: 8 })
  } else {
    input.topContacts.forEach((c, i) => {
      const kind = c.kind ? ` (${c.kind.replace('_', ' ')})` : ''
      blocks.push({
        text: `${i + 1}. ${c.name}${kind} — ${c.count} call${c.count === 1 ? '' : 's'}`,
        size: 11,
        spacingBefore: i === 0 ? 8 : 3,
      })
    })
  }

  blocks.push({ text: '— StudyMind CRM', size: 10, spacingBefore: 24 })

  return renderPaginatedTextDocumentPdf(blocks)
}
