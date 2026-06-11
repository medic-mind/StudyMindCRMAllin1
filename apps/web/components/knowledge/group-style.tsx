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

import type { KnowledgeTone } from './knowledge-node'

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>

export interface GroupStyle {
  tone: KnowledgeTone
  Icon: IconComp
  /** Icon chip — text + background. */
  chip: string
  /** Card hover accent. */
  hover: string
}

const STYLES: Record<KnowledgeGroup, GroupStyle> = {
  'Brands & products': {
    tone: 'brand',
    Icon: BuildingIcon,
    chip: 'bg-primary-50 text-primary-600',
    hover: 'hover:border-primary-300 hover:bg-primary-50/30',
  },
  'Packages & pricing': {
    tone: 'pricing',
    Icon: CoinsIcon,
    chip: 'bg-emerald-50 text-emerald-600',
    hover: 'hover:border-emerald-300 hover:bg-emerald-50/30',
  },
  'Sales playbook': {
    tone: 'playbook',
    Icon: MegaphoneIcon,
    chip: 'bg-amber-50 text-amber-600',
    hover: 'hover:border-amber-300 hover:bg-amber-50/30',
  },
  'Events & operations': {
    tone: 'events',
    Icon: CalendarIcon,
    chip: 'bg-sky-50 text-sky-600',
    hover: 'hover:border-sky-300 hover:bg-sky-50/30',
  },
  Reference: {
    tone: 'reference',
    Icon: BookOpenIcon,
    chip: 'bg-violet-50 text-violet-600',
    hover: 'hover:border-violet-300 hover:bg-violet-50/30',
  },
  Custom: {
    tone: 'neutral',
    Icon: FileTextIcon,
    chip: 'bg-neutral-100 text-neutral-600',
    hover: 'hover:border-neutral-300 hover:bg-neutral-50',
  },
}

export function groupStyle(group: KnowledgeGroup): GroupStyle {
  return STYLES[group] ?? STYLES.Custom
}
