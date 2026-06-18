import type { Source } from '../../shared/types'

export interface SourceDraft {
  kind: Source['kind']
  query: string
  personIds: Set<string>
  favoritesOnly: boolean
}

export function toDraft(s: Source): SourceDraft {
  return {
    kind: s.kind,
    query: s.kind === 'theme' ? s.query : '',
    personIds: new Set(
      s.kind === 'theme' ? s.personIds ?? [] : s.kind === 'person' ? s.personIds : []
    ),
    favoritesOnly: s.kind === 'random' ? Boolean(s.favoritesOnly) : false
  }
}

export function buildSource(d: SourceDraft): Source {
  if (d.kind === 'theme') {
    const s: Source = { kind: 'theme', query: d.query.trim() }
    if (d.personIds.size) s.personIds = [...d.personIds]
    return s
  }
  if (d.kind === 'person') return { kind: 'person', personIds: [...d.personIds] }
  return { kind: 'random', favoritesOnly: d.favoritesOnly }
}

export function validateSource(d: SourceDraft): string | null {
  if (d.kind === 'theme' && !d.query.trim()) return 'Enter a theme/topic query.'
  if (d.kind === 'person' && d.personIds.size === 0) return 'Select at least one person.'
  return null
}
