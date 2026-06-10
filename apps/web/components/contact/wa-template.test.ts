import { describe, expect, it } from 'vitest'

import { missingWaParams, parseWaTemplateSegments, renderWaTemplate } from './wa-template'

describe('parseWaTemplateSegments', () => {
  it('splits text and placeholders in order', () => {
    expect(parseWaTemplateSegments('Hi {{1}}, your {{2}} pack is ready.')).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'param', key: '{{1}}', first: true },
      { kind: 'text', text: ', your ' },
      { kind: 'param', key: '{{2}}', first: true },
      { kind: 'text', text: ' pack is ready.' },
    ])
  })

  it('marks only the first occurrence of a repeated key as editable', () => {
    const segments = parseWaTemplateSegments('{{1}} and {{1}} again')
    expect(segments).toEqual([
      { kind: 'param', key: '{{1}}', first: true },
      { kind: 'text', text: ' and ' },
      { kind: 'param', key: '{{1}}', first: false },
      { kind: 'text', text: ' again' },
    ])
  })

  it('tolerates whitespace inside the braces and preserves newlines', () => {
    expect(parseWaTemplateSegments('Line one {{ 1 }}\nLine two')).toEqual([
      { kind: 'text', text: 'Line one ' },
      { kind: 'param', key: '{{1}}', first: true },
      { kind: 'text', text: '\nLine two' },
    ])
  })

  it('returns one text segment for a template without params', () => {
    expect(parseWaTemplateSegments('Static message.')).toEqual([
      { kind: 'text', text: 'Static message.' },
    ])
  })
})

describe('renderWaTemplate', () => {
  it('substitutes filled values and keeps unfilled placeholders', () => {
    expect(renderWaTemplate('Hi {{1}}, see {{2}}', { '{{1}}': 'Jess' })).toBe(
      'Hi Jess, see {{2}}',
    )
  })

  it('substitutes every occurrence of a repeated key', () => {
    expect(renderWaTemplate('{{1}} and {{1}}', { '{{1}}': 'A' })).toBe('A and A')
  })
})

describe('missingWaParams', () => {
  it('lists keys without a (non-blank) value', () => {
    expect(missingWaParams(['{{1}}', '{{2}}'], { '{{1}}': 'Jess', '{{2}}': '  ' })).toEqual([
      '{{2}}',
    ])
  })

  it('is empty when everything is filled', () => {
    expect(missingWaParams(['{{1}}'], { '{{1}}': 'x' })).toEqual([])
  })
})
