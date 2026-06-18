import { describe, it, expect, vi } from 'vitest'
import { SourcePool } from '../src/main/source'
import type { ImmichClient } from '../src/main/immich'

function makeClient(ids: string[]): ImmichClient {
  return {
    resolvePool: vi.fn().mockResolvedValue(ids)
  } as unknown as ImmichClient
}

describe('SourcePool.next', () => {
  it('returns null for an empty pool', async () => {
    const pool = new SourcePool({ kind: 'random' }, makeClient([]), 10)
    await pool.ensureLoaded()
    expect(pool.next()).toBeNull()
  })

  it('returns all ids before repeating', async () => {
    const pool = new SourcePool({ kind: 'theme', query: 'test' }, makeClient(['a', 'b', 'c']), 3)
    await pool.ensureLoaded()
    const drawn = new Set([pool.next(), pool.next(), pool.next()])
    expect(drawn).toEqual(new Set(['a', 'b', 'c']))
  })

  it('reshuffles and continues after the bag is exhausted', async () => {
    const pool = new SourcePool({ kind: 'theme', query: 'test' }, makeClient(['a', 'b']), 2)
    await pool.ensureLoaded()
    const counts: Record<string, number> = { a: 0, b: 0 }
    for (let i = 0; i < 6; i++) counts[pool.next()!]++
    expect(counts['a']).toBe(3)
    expect(counts['b']).toBe(3)
  })

  it('skips excluded ids when alternatives exist', async () => {
    const pool = new SourcePool({ kind: 'theme', query: 'test' }, makeClient(['a', 'b', 'c']), 3)
    await pool.ensureLoaded()
    // Drain the bag to a known state, then check exclusion
    const drawn: string[] = []
    for (let i = 0; i < 3; i++) drawn.push(pool.next()!)
    // Now refill with only 'c' excluded — next should not return 'c' if alternatives remain
    const exclude = new Set(['c'])
    for (let i = 0; i < 6; i++) {
      const id = pool.next(exclude)
      expect(id).not.toBe('c')
    }
  })

  it('still returns something when all ids are excluded', async () => {
    const pool = new SourcePool({ kind: 'theme', query: 'test' }, makeClient(['a', 'b']), 2)
    await pool.ensureLoaded()
    const exclude = new Set(['a', 'b'])
    expect(pool.next(exclude)).not.toBeNull()
  })
})

describe('SourcePool.peek', () => {
  it('returns up to n upcoming ids', async () => {
    const pool = new SourcePool({ kind: 'theme', query: 'test' }, makeClient(['a', 'b', 'c']), 3)
    await pool.ensureLoaded()
    const peeked = pool.peek(2)
    expect(peeked).toHaveLength(2)
  })

  it('is non-destructive: all ids still drawable after peek', async () => {
    const pool = new SourcePool({ kind: 'theme', query: 'test' }, makeClient(['a', 'b', 'c']), 3)
    await pool.ensureLoaded()
    pool.peek(3)
    const drawn = new Set([pool.next(), pool.next(), pool.next()])
    expect(drawn).toEqual(new Set(['a', 'b', 'c']))
  })
})

describe('SourcePool.assetIds', () => {
  it('exposes the resolved id list', async () => {
    const ids = ['x', 'y', 'z']
    const pool = new SourcePool({ kind: 'theme', query: 'test' }, makeClient(ids), 3)
    await pool.ensureLoaded()
    expect(new Set(pool.assetIds)).toEqual(new Set(ids))
  })
})
