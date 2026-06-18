import { describe, it, expect } from 'vitest'
import { normalizeBaseUrl } from '../src/main/immich'

describe('normalizeBaseUrl', () => {
  it('strips a trailing slash', () =>
    expect(normalizeBaseUrl('http://myserver/')).toBe('http://myserver'))

  it('strips multiple trailing slashes', () =>
    expect(normalizeBaseUrl('http://myserver///')).toBe('http://myserver'))

  it('strips a /api suffix', () =>
    expect(normalizeBaseUrl('http://myserver/api')).toBe('http://myserver'))

  it('strips /api with a trailing slash', () =>
    expect(normalizeBaseUrl('http://myserver/api/')).toBe('http://myserver'))

  it('leaves a clean URL unchanged', () =>
    expect(normalizeBaseUrl('http://myserver:2283')).toBe('http://myserver:2283'))

  it('preserves port when stripping /api', () =>
    expect(normalizeBaseUrl('http://myserver:2283/api')).toBe('http://myserver:2283'))

  it('trims leading and trailing whitespace', () =>
    expect(normalizeBaseUrl('  http://myserver  ')).toBe('http://myserver'))

  it('handles https scheme', () =>
    expect(normalizeBaseUrl('https://photos.example.com/api')).toBe('https://photos.example.com'))
})
