// Snapshot lock for the brand token shape. CLAUDE.md §4: Tailwind reads
// from these and a token change should always show up in PR diffs.
//
// We snapshot the *keys* of each token group (not the values) so the
// snapshot fails when names are added/removed/renamed but tolerates
// values shifting under design review.

import { describe, expect, it } from 'vitest'

import { colors, radius, spacing, typography } from '../index'

function shallowKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort()
}

function nested(obj: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = Object.keys(v as Record<string, unknown>).sort()
    } else {
      out[key] = []
    }
  }
  return out
}

describe('tokens shape', () => {
  it('colors token names are stable', () => {
    expect(nested(colors)).toMatchInlineSnapshot(`
      {
        "danger": [
          "100",
          "200",
          "50",
          "500",
          "600",
          "700",
          "900",
        ],
        "info": [
          "100",
          "200",
          "50",
          "500",
          "600",
          "700",
          "900",
        ],
        "neutral": [
          "0",
          "100",
          "200",
          "300",
          "400",
          "50",
          "500",
          "600",
          "700",
          "800",
          "900",
          "950",
        ],
        "primary": [
          "100",
          "200",
          "300",
          "400",
          "50",
          "500",
          "600",
          "700",
          "800",
          "900",
          "950",
        ],
        "secondary": [
          "100",
          "200",
          "300",
          "400",
          "50",
          "500",
          "600",
          "700",
          "800",
          "900",
          "950",
        ],
        "success": [
          "100",
          "200",
          "50",
          "500",
          "600",
          "700",
          "900",
        ],
        "warning": [
          "100",
          "200",
          "50",
          "500",
          "600",
          "700",
          "900",
        ],
      }
    `)
  })

  it('typography token groups are stable', () => {
    expect(shallowKeys(typography)).toMatchInlineSnapshot(`
      [
        "fontFamily",
        "fontFeatureSettings",
        "fontSize",
        "fontWeight",
        "letterSpacing",
      ]
    `)
    expect(shallowKeys(typography.fontFeatureSettings)).toMatchInlineSnapshot(`
      [
        "default",
        "tabular",
      ]
    `)
  })

  it('spacing + radius tokens are non-empty', () => {
    expect(Object.keys(spacing).length).toBeGreaterThan(0)
    expect(Object.keys(radius).length).toBeGreaterThan(0)
  })
})
