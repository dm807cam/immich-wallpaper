import { describe, it, expect } from 'vitest'
import { toDraft, buildSource, validateSource } from '../src/renderer/ui/source-draft'

describe('toDraft', () => {
  it('converts a theme source', () => {
    const d = toDraft({ kind: 'theme', query: 'beach sunsets', personIds: ['p1'] })
    expect(d.kind).toBe('theme')
    expect(d.query).toBe('beach sunsets')
    expect(d.personIds).toEqual(new Set(['p1']))
    expect(d.favoritesOnly).toBe(false)
  })

  it('converts a theme source with no optional fields', () => {
    const d = toDraft({ kind: 'theme', query: 'mountains' })
    expect(d.personIds.size).toBe(0)
  })

  it('converts a person source', () => {
    const d = toDraft({ kind: 'person', personIds: ['p1', 'p2'] })
    expect(d.kind).toBe('person')
    expect(d.personIds).toEqual(new Set(['p1', 'p2']))
    expect(d.query).toBe('')
  })

  it('converts a random source', () => {
    const d = toDraft({ kind: 'random', favoritesOnly: true })
    expect(d.kind).toBe('random')
    expect(d.favoritesOnly).toBe(true)
    expect(d.personIds.size).toBe(0)
  })

  it('converts a random source with no favoritesOnly field', () => {
    const d = toDraft({ kind: 'random' })
    expect(d.favoritesOnly).toBe(false)
  })
})

describe('buildSource', () => {
  it('round-trips a theme source without personIds', () => {
    const src = { kind: 'theme' as const, query: 'mountains' }
    expect(buildSource(toDraft(src))).toEqual(src)
  })

  it('round-trips a theme source with personIds', () => {
    const src = { kind: 'theme' as const, query: 'beach', personIds: ['p1'] }
    expect(buildSource(toDraft(src))).toEqual(src)
  })

  it('omits personIds key when set is empty in theme mode', () => {
    const result = buildSource({
      kind: 'theme',
      query: 'nature',
      personIds: new Set(),
      favoritesOnly: false
    })
    expect(result).toEqual({ kind: 'theme', query: 'nature' })
    expect('personIds' in result).toBe(false)
  })

  it('includes personIds when populated in theme mode', () => {
    const result = buildSource({
      kind: 'theme',
      query: 'nature',
      personIds: new Set(['p1', 'p2']),
      favoritesOnly: false
    })
    expect(result.kind).toBe('theme')
    if (result.kind === 'theme') expect(new Set(result.personIds)).toEqual(new Set(['p1', 'p2']))
  })

  it('round-trips a person source', () => {
    const src = { kind: 'person' as const, personIds: ['p1'] }
    expect(buildSource(toDraft(src))).toEqual(src)
  })

  it('round-trips a random source', () => {
    const src = { kind: 'random' as const, favoritesOnly: true }
    expect(buildSource(toDraft(src))).toEqual(src)
  })

  it('trims whitespace from the theme query', () => {
    const result = buildSource({
      kind: 'theme',
      query: '  nature  ',
      personIds: new Set(),
      favoritesOnly: false
    })
    expect(result.kind === 'theme' && result.query).toBe('nature')
  })
})

// Regression: switching from Person to Theme must not carry over selected people.
// The bug: onchange only updated draft.kind, leaving personIds populated, so those
// ids were sent to /search/smart and overrode the text query entirely.
describe('kind-switch regression — personIds must not leak across modes', () => {
  it('person → theme: clearing personIds produces a clean theme source', () => {
    const draft = toDraft({ kind: 'person', personIds: ['p1', 'p2'] })
    expect(draft.personIds.size).toBe(2)

    // Simulate what the fixed onchange handler now does
    draft.kind = 'theme'
    draft.personIds = new Set()
    draft.query = 'nature no people'

    const source = buildSource(draft)
    expect(source.kind).toBe('theme')
    expect('personIds' in source).toBe(false)
  })

  it('theme → person: switching does not carry the query into the person source', () => {
    const draft = toDraft({ kind: 'theme', query: 'mountains', personIds: ['p1'] })

    draft.kind = 'person'
    draft.personIds = new Set()
    // person mode is invalid without people, but structurally the query field is irrelevant
    draft.personIds.add('p2')

    const source = buildSource(draft)
    expect(source.kind).toBe('person')
    expect(source.personIds).toEqual(['p2'])
  })
})

describe('validateSource', () => {
  it('rejects a theme source with an empty query', () => {
    expect(
      validateSource({ kind: 'theme', query: '', personIds: new Set(), favoritesOnly: false })
    ).not.toBeNull()
  })

  it('rejects a theme source with a whitespace-only query', () => {
    expect(
      validateSource({ kind: 'theme', query: '   ', personIds: new Set(), favoritesOnly: false })
    ).not.toBeNull()
  })

  it('accepts a theme source with a non-empty query', () => {
    expect(
      validateSource({ kind: 'theme', query: 'nature', personIds: new Set(), favoritesOnly: false })
    ).toBeNull()
  })

  it('rejects a person source with no people selected', () => {
    expect(
      validateSource({ kind: 'person', query: '', personIds: new Set(), favoritesOnly: false })
    ).not.toBeNull()
  })

  it('accepts a person source with at least one person', () => {
    expect(
      validateSource({ kind: 'person', query: '', personIds: new Set(['p1']), favoritesOnly: false })
    ).toBeNull()
  })

  it('accepts any random source', () => {
    expect(
      validateSource({ kind: 'random', query: '', personIds: new Set(), favoritesOnly: false })
    ).toBeNull()
  })
})
