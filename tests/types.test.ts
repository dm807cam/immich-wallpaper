import { describe, it, expect } from 'vitest'
import { intervalToMs, justifiedLayout, layoutCells, layoutRows } from '../src/shared/types'

describe('intervalToMs', () => {
  it('converts minutes', () => expect(intervalToMs({ every: 5, unit: 'minute' })).toBe(300_000))
  it('converts hours', () => expect(intervalToMs({ every: 2, unit: 'hour' })).toBe(7_200_000))
  it('converts days', () => expect(intervalToMs({ every: 1, unit: 'day' })).toBe(86_400_000))
  it('scales linearly', () => expect(intervalToMs({ every: 3, unit: 'hour' })).toBe(3 * 3_600_000))
})

describe('layoutRows', () => {
  it('grid-2x2 has 2 rows', () => expect(layoutRows('grid-2x2')).toBe(2))
  it('grid-3x2 has 2 rows', () => expect(layoutRows('grid-3x2')).toBe(2))
  it('grid-1x3 has 1 row', () => expect(layoutRows('grid-1x3')).toBe(1))
})

describe('layoutCells', () => {
  it('grid-2x2 produces 4 rects whose areas sum to 1', () => {
    const cells = layoutCells('grid-2x2')
    expect(cells).toHaveLength(4)
    const area = cells.reduce((s, r) => s + r.w * r.h, 0)
    expect(area).toBeCloseTo(1)
  })

  it('grid-3x2 produces 6 rects whose areas sum to 1', () => {
    const cells = layoutCells('grid-3x2')
    expect(cells).toHaveLength(6)
    const area = cells.reduce((s, r) => s + r.w * r.h, 0)
    expect(area).toBeCloseTo(1)
  })

  it('grid-1x3 produces 3 rects whose areas sum to 1', () => {
    const cells = layoutCells('grid-1x3')
    expect(cells).toHaveLength(3)
    const area = cells.reduce((s, r) => s + r.w * r.h, 0)
    expect(area).toBeCloseTo(1)
  })

  it('all rects stay within the unit canvas', () => {
    for (const layout of ['grid-2x2', 'grid-3x2', 'grid-1x3'] as const) {
      for (const r of layoutCells(layout)) {
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
        expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })
})

describe('justifiedLayout', () => {
  it('returns empty for empty input', () => {
    expect(justifiedLayout([], 2)).toEqual([])
  })

  it('single image fills the canvas', () => {
    const [r] = justifiedLayout([16 / 9], 1)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    expect(r.w).toBeCloseTo(1)
    expect(r.h).toBeCloseTo(1)
  })

  it('widths in a single row sum to 1', () => {
    const rects = justifiedLayout([1, 2, 0.5], 1)
    expect(rects.reduce((s, r) => s + r.w, 0)).toBeCloseTo(1)
  })

  it('heights across rows sum to 1', () => {
    // Two rows of two images each
    const rects = justifiedLayout([1, 1, 1, 1], 2)
    // First row y=0, second row y=0.5 — both heights add to 1
    const uniqueYs = [...new Set(rects.map((r) => r.y))]
    expect(uniqueYs).toHaveLength(2)
    const totalH = uniqueYs.reduce((s, y) => {
      const h = rects.find((r) => r.y === y)!.h
      return s + h
    }, 0)
    expect(totalH).toBeCloseTo(1)
  })

  it('all rects stay within the unit canvas', () => {
    const rects = justifiedLayout([1, 2, 0.5, 1.5, 0.8], 2)
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('produces one rect per image', () => {
    const aspects = [1, 1.5, 0.75, 2]
    expect(justifiedLayout(aspects, 2)).toHaveLength(aspects.length)
  })
})
