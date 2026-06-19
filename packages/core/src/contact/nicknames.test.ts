import { describe, expect, it } from 'vitest'

import { nameVariants } from './nicknames'

describe('nameVariants', () => {
  it('expands a nickname to its canonical form and back', () => {
    expect(nameVariants('Liz')).toEqual(expect.arrayContaining(['liz', 'elizabeth']))
    expect(nameVariants('Elizabeth')).toEqual(expect.arrayContaining(['elizabeth', 'liz', 'beth']))
  })

  it('links siblings of the same canonical name', () => {
    // Jon and Jonny both map to Jonathan, so they are equivalent to each other.
    expect(nameVariants('jon')).toEqual(expect.arrayContaining(['jonathan', 'jonny']))
  })

  it('always includes the token itself, lower-cased', () => {
    expect(nameVariants('Tom')).toContain('tom')
  })

  it('returns just the token for an unknown name', () => {
    expect(nameVariants('Zephyr')).toEqual(['zephyr'])
  })

  it('returns nothing for blank input', () => {
    expect(nameVariants('   ')).toEqual([])
  })
})
