import { app, screen } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { AssetCache } from './cache'
import {
  composeCanvas,
  composeSingle,
  orientedSize,
  resizeTile,
  type Focal,
  type PositionedTile
} from './collage'
import type { ImmichClient } from './immich'
import { SourcePool } from './source'
import { setWallpaperAllDisplays } from './wallpaper'
import {
  justifiedLayout,
  layoutCells,
  layoutRows,
  type Rect,
  type WallpaperConfig,
  type Source
} from '../shared/types'

const COLLAGE_DEBOUNCE_MS = 500
const KEEP_OUTPUTS = 4
const TILE_CACHE_MAX = 32
const TILE_CACHE_MAX_BYTES = 128 * 1024 * 1024 // 128 MB — raw pixel buffers can be large on HiDPI
// Cap how many tiles download/decode at once so a many-tile collage of large
// images can't spike memory or saturate the CPU.
const TILE_CONCURRENCY = 3

/** Run `fn` over `items` with at most `limit` in flight, preserving result order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Owns all wallpaper state: source pools, collage cell contents, and the
 * compose+apply pipeline. The Scheduler drives it via advanceAllCells/renderSingle.
 */
export class WallpaperEngine {
  private cache = new AssetCache()
  private outDir = join(app.getPath('temp'), 'immich-wallpaper', 'out')
  private outCounter = 0

  private client: ImmichClient | null = null
  private config: WallpaperConfig | null = null

  // single mode
  private singlePool: SourcePool | null = null
  // collage mode
  private sharedPool: SourcePool | null = null
  private cellPools: (SourcePool | null)[] = []
  private cellRects: Rect[] = []
  private cellImages: (string | null)[] = []

  // Oriented pixel dimensions per asset id (stable; probed once from the cached file).
  private sizeById = new Map<string, { w: number; h: number }>()
  // Face-crop focal point per asset id (null = no faces -> centre crop). Cached.
  private focalById = new Map<string, Focal | null>()
  // Resized tile pixels keyed by `${id}@${w}x${h}` so a tile reused at the same
  // size (e.g. across applyNow / re-justify) is not re-decoded/re-resized.
  private tileCache = new Map<string, Buffer>()
  private tileCacheBytes = 0

  private flushTimer: NodeJS.Timeout | null = null
  private busy = false
  // Collage similarity enrichment is a one-time-per-config network step, not per paint.
  private collageEnriched = false

  constructor() {
    void fs.mkdir(this.outDir, { recursive: true })
  }

  setClient(client: ImmichClient | null): void {
    this.client = client
  }

  hasClient(): boolean {
    return this.client !== null
  }

  /** Rebuild all pools/state for a new active config. Does not apply. */
  setConfig(config: WallpaperConfig): void {
    this.config = config
    this.tileCache.clear() // tile dimensions change with layout/source
    this.tileCacheBytes = 0
    this.sizeById.clear()
    this.focalById.clear()
    this.collageEnriched = false
    if (!this.client) return

    if (config.mode === 'single') {
      this.singlePool = new SourcePool(config.source, this.client)
      this.sharedPool = null
      this.cellPools = []
      this.cellImages = []
    } else {
      const rects =
        config.layout === 'custom'
          ? config.cells.map((c) => c.rect)
          : layoutCells(config.layout)
      this.cellRects = rects
      this.sharedPool = new SourcePool(config.source, this.client)
      this.cellPools = config.cells.map((c) =>
        c.source ? new SourcePool(c.source, this.client!) : null
      )
      this.cellImages = config.cells.map(() => null)
      this.singlePool = null
    }
  }

  private poolForCell(i: number): SourcePool {
    return this.cellPools[i] ?? this.sharedPool!
  }

  /** Oriented pixel dimensions of an asset, probed once and memoized. */
  private async cellSize(id: string, path: string): Promise<{ w: number; h: number }> {
    const hit = this.sizeById.get(id)
    if (hit) return hit
    const size = await orientedSize(path).catch(() => ({ w: 1, h: 1 }))
    this.sizeById.set(id, size)
    return size
  }

  /** Face-crop focal point for an asset (centre of detected faces), memoized. */
  private async cellFocal(id: string): Promise<Focal | undefined> {
    if (this.focalById.has(id)) return this.focalById.get(id) ?? undefined
    let focal: Focal | null = null
    try {
      const boxes = await this.client!.faces(id)
      if (boxes.length > 0) {
        // Center on the union of all faces so the whole group stays in frame.
        const x1 = Math.min(...boxes.map((b) => b.x1))
        const y1 = Math.min(...boxes.map((b) => b.y1))
        const x2 = Math.max(...boxes.map((b) => b.x2))
        const y2 = Math.max(...boxes.map((b) => b.y2))
        focal = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
      }
    } catch {
      /* best-effort; fall back to centre crop */
    }
    this.focalById.set(id, focal)
    return focal ?? undefined
  }

  /** Resized tile pixels, served from an LRU buffer cache when dimensions match. */
  private async tilePixels(
    id: string,
    path: string,
    w: number,
    h: number,
    focal?: Focal
  ): Promise<Buffer> {
    const key = `${id}@${w}x${h}`
    const hit = this.tileCache.get(key)
    if (hit) {
      // Refresh LRU recency.
      this.tileCache.delete(key)
      this.tileCache.set(key, hit)
      return hit
    }
    // Pass the already-memoized source dimensions so resizeTile doesn't need a
    // second sharp().metadata() call when a focal crop is requested.
    const srcSize = this.sizeById.get(id)
    const buf = await resizeTile(path, w, h, focal, srcSize)
    this.tileCache.set(key, buf)
    this.tileCacheBytes += buf.length
    while (this.tileCache.size > TILE_CACHE_MAX || this.tileCacheBytes > TILE_CACHE_MAX_BYTES) {
      const oldest = this.tileCache.keys().next().value
      if (oldest === undefined) break
      const evicted = this.tileCache.get(oldest)!
      this.tileCacheBytes -= evicted.length
      this.tileCache.delete(oldest)
    }
    return buf
  }

  private displayPixels(): { width: number; height: number } {
    const d = screen.getPrimaryDisplay()
    return {
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor)
    }
  }

  private async nextOutPath(ext: string): Promise<string> {
    // Rotate filenames so macOS reliably refreshes the wallpaper (it caches by path).
    this.outCounter = (this.outCounter + 1) % 1_000_000
    const path = join(this.outDir, `wp-${Date.now()}-${this.outCounter}.${ext}`)
    void this.cleanupOldOutputs()
    return path
  }

  private async cleanupOldOutputs(): Promise<void> {
    try {
      const files = (await fs.readdir(this.outDir))
        .filter((f) => f.startsWith('wp-'))
        .sort()
      const stale = files.slice(0, Math.max(0, files.length - KEEP_OUTPUTS))
      await Promise.all(stale.map((f) => fs.rm(join(this.outDir, f), { force: true })))
    } catch {
      /* ignore */
    }
  }

  // --- single mode -----------------------------------------------------------

  async renderSingle(): Promise<void> {
    if (!this.client || !this.singlePool) return
    await this.singlePool.ensureLoaded()
    const id = this.singlePool.next()
    if (!id) throw new Error('No images matched this source.')
    const src = await this.cache.get(id, this.client)
    const { width, height } = this.displayPixels()
    const focal = await this.cellFocal(id)
    const srcSize = focal ? await this.cellSize(id, src) : undefined
    const out = await composeSingle(src, width, height, await this.nextOutPath('jpg'), focal, srcSize)
    await setWallpaperAllDisplays(out)
    this.cache.prefetch(this.singlePool.peek(3), this.client)
  }

  // --- collage mode ----------------------------------------------------------

  /** Optional similarity enrichment: bias a theme collage toward the seed's people. */
  private async enrichCollageSimilarity(): Promise<void> {
    if (!this.client || !this.sharedPool) return
    if (this.sharedPool.source.kind !== 'theme') return
    const ids = this.sharedPool.assetIds
    if (ids.length === 0) return
    try {
      const seed = await this.client.asset(ids[0])
      const personIds = (seed.people ?? []).map((p) => p.id).slice(0, 2)
      if (personIds.length === 0) return
      const base = this.sharedPool.source
      const refined: Source = { ...base, personIds }
      this.sharedPool = new SourcePool(refined, this.client)
      await this.sharedPool.refresh()
      // If the narrowed pool is too small, fall back to the original theme pool.
      if (this.sharedPool.assetIds.length < this.cellImages.length) {
        this.sharedPool = new SourcePool(base, this.client)
        await this.sharedPool.refresh()
      }
    } catch {
      /* best-effort; keep the unrefined pool */
    }
  }

  /** Pick a fresh image for every collage cell, then re-composite once. */
  async advanceAllCells(): Promise<void> {
    if (!this.client || this.config?.mode !== 'collage') return
    const chosen = new Set<string>()
    for (let i = 0; i < this.cellImages.length; i++) {
      const pool = this.poolForCell(i)
      await pool.ensureLoaded()
      const id = pool.next(chosen)
      if (id) {
        this.cellImages[i] = id
        chosen.add(id)
      }
    }
    await this.flushCollage()
  }

  private scheduleCollageFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushCollage().catch((e) => console.error('[collage flush]', e))
    }, COLLAGE_DEBOUNCE_MS)
  }

  /** Composite the current cell images and apply as one wallpaper. */
  async flushCollage(): Promise<void> {
    const cfg = this.config
    if (!this.client || !cfg || cfg.mode !== 'collage') return
    if (this.busy) {
      this.scheduleCollageFlush()
      return
    }
    this.busy = true
    try {
      // Fill any still-empty cells before the first paint.
      for (let i = 0; i < this.cellImages.length; i++) {
        if (this.cellImages[i]) continue
        const pool = this.poolForCell(i)
        await pool.ensureLoaded()
        const exclude = new Set(this.cellImages.filter(Boolean) as string[])
        this.cellImages[i] = pool.next(exclude)
      }
      const usable = this.cellImages
        .map((id, i) => ({ id, i }))
        .filter((c): c is { id: string; i: number } => Boolean(c.id))
      if (usable.length === 0) throw new Error('No images matched this collage source.')

      // Resolve each tile's local file + oriented dimensions (concurrency-capped).
      const tiles = await mapLimit(usable, TILE_CONCURRENCY, async ({ id, i }) => {
        const path = await this.cache.get(id, this.client!)
        const size = await this.cellSize(id, path)
        return { id, i, path, aspect: size.w / (size.h || 1) }
      })

      // Size tiles to the images: justified mosaic for grid presets, the
      // user-drawn rects for custom layouts.
      const rects =
        cfg.layout === 'custom'
          ? tiles.map((t) => this.cellRects[t.i])
          : justifiedLayout(
              tiles.map((t) => t.aspect),
              layoutRows(cfg.layout)
            )

      const { width, height } = this.displayPixels()
      const half = Math.round(cfg.gap / 2)
      const composites: PositionedTile[] = await mapLimit(tiles, TILE_CONCURRENCY, async (t, k) => {
        const r = rects[k]
        const left = Math.round(r.x * width) + half
        const top = Math.round(r.y * height) + half
        const cw = Math.max(1, Math.round(r.w * width) - cfg.gap)
        const ch = Math.max(1, Math.round(r.h * height) - cfg.gap)
        const focal = await this.cellFocal(t.id)
        return { input: await this.tilePixels(t.id, t.path, cw, ch, focal), left, top }
      })

      const out = await composeCanvas(
        width,
        height,
        cfg.background,
        composites,
        await this.nextOutPath('jpg')
      )
      await setWallpaperAllDisplays(out)
    } finally {
      this.busy = false
    }
  }

  // --- entry points ----------------------------------------------------------

  /** Force an immediate full refresh (used by "Next wallpaper now" and on start). */
  async applyNow(): Promise<void> {
    if (!this.config) return
    if (this.config.mode === 'single') {
      await this.renderSingle()
    } else {
      this.cellImages = this.cellImages.map(() => null)
      if (this.sharedPool) {
        await this.sharedPool.ensureLoaded()
        if (!this.collageEnriched) {
          await this.enrichCollageSimilarity()
          this.collageEnriched = true
        }
      }
      await this.flushCollage()
    }
  }

  get mode(): 'single' | 'collage' | null {
    return this.config?.mode ?? null
  }
  get cellCount(): number {
    return this.cellImages.length
  }
}
