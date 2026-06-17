import { z } from 'zod'

// ---------------------------------------------------------------------------
// Rotation interval
// ---------------------------------------------------------------------------
export const IntervalUnit = z.enum(['minute', 'hour', 'day'])
export type IntervalUnit = z.infer<typeof IntervalUnit>

export const Interval = z.object({
  every: z.number().int().positive(),
  unit: IntervalUnit
})
export type Interval = z.infer<typeof Interval>

export function intervalToMs(i: Interval): number {
  const base = i.unit === 'minute' ? 60_000 : i.unit === 'hour' ? 3_600_000 : 86_400_000
  return i.every * base
}

// ---------------------------------------------------------------------------
// Source: how images are selected from Immich
// ---------------------------------------------------------------------------
export const ThemeSource = z.object({
  kind: z.literal('theme'),
  query: z.string().min(1),
  personIds: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  albumIds: z.array(z.string()).optional()
})
export const PersonSource = z.object({
  kind: z.literal('person'),
  personIds: z.array(z.string()).min(1)
})
export const RandomSource = z.object({
  kind: z.literal('random'),
  favoritesOnly: z.boolean().optional()
})
export const Source = z.discriminatedUnion('kind', [ThemeSource, PersonSource, RandomSource])
export type Source = z.infer<typeof Source>

// ---------------------------------------------------------------------------
// Collage cell
// ---------------------------------------------------------------------------
export const Rect = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1)
})
export type Rect = z.infer<typeof Rect>

export const Cell = z.object({
  // When omitted, the cell inherits the collage's shared source.
  source: Source.optional(),
  // Deprecated: all tiles now rotate together on the collage interval. Kept
  // optional so older saved configs/presets still parse.
  interval: Interval.optional(),
  rect: Rect
})
export type Cell = z.infer<typeof Cell>

// ---------------------------------------------------------------------------
// Wallpaper config (single | collage)
// ---------------------------------------------------------------------------
export const CollageLayout = z.enum(['grid-2x2', 'grid-3x2', 'grid-1x3', 'custom'])
export type CollageLayout = z.infer<typeof CollageLayout>

export const SingleConfig = z.object({
  mode: z.literal('single'),
  source: Source,
  interval: Interval
})
export const CollageConfig = z.object({
  mode: z.literal('collage'),
  source: Source,
  layout: CollageLayout,
  cells: z.array(Cell).min(1),
  // All tiles refresh together on this interval.
  interval: Interval.default({ every: 30, unit: 'minute' }),
  gap: z.number().min(0).default(8),
  background: z.string().default('#000000')
})
export const WallpaperConfig = z.discriminatedUnion('mode', [SingleConfig, CollageConfig])
export type WallpaperConfig = z.infer<typeof WallpaperConfig>

// ---------------------------------------------------------------------------
// App config (persisted; api key stored separately via safeStorage)
// ---------------------------------------------------------------------------
export const ServerConfig = z.object({
  baseUrl: z.string().url().or(z.literal(''))
})

export const AppConfig = z.object({
  server: ServerConfig,
  active: WallpaperConfig,
  presets: z.record(z.string(), WallpaperConfig).default({}),
  paused: z.boolean().default(false),
  launchAtLogin: z.boolean().default(true)
})
export type AppConfig = z.infer<typeof AppConfig>

// ---------------------------------------------------------------------------
// Layout presets -> normalized cell rects
// ---------------------------------------------------------------------------
export function layoutCells(layout: Exclude<CollageLayout, 'custom'>): Rect[] {
  switch (layout) {
    case 'grid-2x2':
      return [
        { x: 0, y: 0, w: 0.5, h: 0.5 },
        { x: 0.5, y: 0, w: 0.5, h: 0.5 },
        { x: 0, y: 0.5, w: 0.5, h: 0.5 },
        { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
      ]
    case 'grid-3x2':
      return [
        { x: 0, y: 0, w: 1 / 3, h: 0.5 },
        { x: 1 / 3, y: 0, w: 1 / 3, h: 0.5 },
        { x: 2 / 3, y: 0, w: 1 / 3, h: 0.5 },
        { x: 0, y: 0.5, w: 1 / 3, h: 0.5 },
        { x: 1 / 3, y: 0.5, w: 1 / 3, h: 0.5 },
        { x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 }
      ]
    case 'grid-1x3':
      return [
        { x: 0, y: 0, w: 1 / 3, h: 1 },
        { x: 1 / 3, y: 0, w: 1 / 3, h: 1 },
        { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }
      ]
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
export const DEFAULT_INTERVAL: Interval = { every: 30, unit: 'minute' }

export function defaultConfig(): AppConfig {
  return {
    server: { baseUrl: '' },
    active: {
      mode: 'single',
      source: { kind: 'random' },
      interval: DEFAULT_INTERVAL
    },
    presets: {},
    paused: false,
    launchAtLogin: true
  }
}

// ---------------------------------------------------------------------------
// Justified ("mosaic") collage layout: tile widths follow each image's aspect
// ratio so portraits get narrow tiles and landscapes wide ones — the canvas is
// still fully filled (rows are scaled to fit), so cropping is minimal.
// ---------------------------------------------------------------------------

/** How many rows a grid preset maps to when laid out by aspect ratio. */
export function layoutRows(layout: Exclude<CollageLayout, 'custom'>): number {
  switch (layout) {
    case 'grid-2x2':
      return 2
    case 'grid-3x2':
      return 2
    case 'grid-1x3':
      return 1
  }
}

/**
 * Pack `aspects` (width/height of each image, in order) into `rowCount` rows that
 * exactly fill a unit canvas. Returns one normalized Rect per image.
 *
 * Horizontal fill is exact (widths in a row sum to 1); rows are then scaled
 * vertically to fill height, which the `cover` resize absorbs as a small crop.
 */
export function justifiedLayout(aspects: number[], rowCount: number): Rect[] {
  const n = aspects.length
  if (n === 0) return []
  const rows = Math.max(1, Math.min(rowCount, n))

  // Partition in order, balanced by count (e.g. 4 images / 2 rows -> 2 + 2).
  const buckets: number[][] = []
  let idx = 0
  for (let r = 0; r < rows; r++) {
    const count = Math.ceil((n - idx) / (rows - r))
    buckets.push(aspects.slice(idx, idx + count))
    idx += count
  }

  const sums = buckets.map((row) => row.reduce((s, a) => s + a, 0) || 1)
  const inv = sums.reduce((t, s) => t + 1 / s, 0) // normalizer for row heights

  const rects: Rect[] = []
  let y = 0
  buckets.forEach((row, r) => {
    const h = 1 / (sums[r] * inv)
    let x = 0
    for (const a of row) {
      const w = a / sums[r]
      rects.push({
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
        w: Math.min(1, Math.max(0, w)),
        h: Math.min(1, Math.max(0, h))
      })
      x += w
    }
    y += h
  })
  return rects
}

// ---------------------------------------------------------------------------
// IPC payloads (renderer <-> main)
// ---------------------------------------------------------------------------
export interface ConnectionStatus {
  ok: boolean
  user?: string
  assetCount?: number
  error?: string
}

export interface PersonSummary {
  id: string
  name: string
  thumbnailUrl?: string
}
export interface AlbumSummary {
  id: string
  name: string
  assetCount: number
}
export interface TagSummary {
  id: string
  name: string
}

export interface PreviewResult {
  count: number
  // base64 data URLs for a few sample thumbnails
  samples: string[]
}
