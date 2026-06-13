// Per-group visual identity for the knowledge base (ADR 0040) — one accent
// tone + icon per section group, shared by the index and section pages so a
// "Pricing" page and its index card read as the same family.

import type { ComponentType, SVGProps } from 'react'

import type { KnowledgeGroup } from '@studymind/core/knowledge'

import {
  BookOpenIcon,
  BuildingIcon,
  CalendarIcon,
  CoinsIcon,
  FileTextIcon,
  MegaphoneIcon,
} from '@/components/ui/icon'

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>

export interface GroupStyle {
  Icon: IconComp
  /** Small category-icon chip — a restrained, purposeful colour cue. */
  chip: string
}

// A distinct icon per group, with a quiet colour chip used only as a small
// category marker (not smeared through the page). Card hover is uniform and
// neutral, so the index reads calm — one accent, used on purpose.
const STYLES: Record<KnowledgeGroup, GroupStyle> = {
  'Brands & products': { Icon: BuildingIcon, chip: 'bg-primary-50 text-primary-600' },
  'Packages & pricing': { Icon: CoinsIcon, chip: 'bg-emerald-50 text-emerald-600' },
  'Sales playbook': { Icon: MegaphoneIcon, chip: 'bg-amber-50 text-amber-600' },
  'Events & operations': { Icon: CalendarIcon, chip: 'bg-sky-50 text-sky-600' },
  Reference: { Icon: BookOpenIcon, chip: 'bg-violet-50 text-violet-600' },
  Custom: { Icon: FileTextIcon, chip: 'bg-neutral-100 text-neutral-500' },
}

/** Uniform, neutral card hover — applied to every knowledge index card. */
export const CARD_HOVER = 'hover:border-neutral-300 hover:bg-neutral-50/70'

export function groupStyle(group: KnowledgeGroup): GroupStyle {
  return STYLES[group] ?? STYLES.Custom
}
