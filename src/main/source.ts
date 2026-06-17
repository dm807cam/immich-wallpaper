import type { ImmichClient } from './immich'
import type { Source } from '../shared/types'

const REFRESH_AFTER_MS = 60 * 60 * 1000 // re-query the server hourly

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** A refreshable pool of asset ids for one Source, with no-immediate-repeat ordering. */
export class SourcePool {
  private ids: string[] = []
  private bag: string[] = []
  private loadedAt = 0

  private readonly size: number

  constructor(
    public readonly source: Source,
    private readonly client: ImmichClient,
    size?: number
  ) {
    // Theme (CLIP) results get less relevant the deeper you page, so cap lower;
    // person/random have no relevance falloff, so pull a big pool for variety.
    this.size = size ?? (source.kind === 'theme' ? 300 : 800)
  }

  get assetIds(): string[] {
    return this.ids
  }

  async ensureLoaded(): Promise<void> {
    const stale = Date.now() - this.loadedAt > REFRESH_AFTER_MS
    // Random + person sources resolve to a fresh randomized sample each query
    // (random: server-side; person: random timeline pages), so when the shuffle
    // bag is exhausted, pull a brand-new batch for endless, time-spread variety.
    const resample =
      (this.source.kind === 'random' || this.source.kind === 'person') &&
      this.ids.length > 0 &&
      this.bag.length === 0
    if (this.ids.length === 0 || stale || resample) await this.refresh()
  }

  async refresh(): Promise<void> {
    this.ids = await this.client.resolvePool(this.source, this.size)
    this.bag = shuffle(this.ids)
    this.loadedAt = Date.now()
  }

  /** Next id, avoiding any in `exclude` (e.g. images shown in other collage cells). */
  next(exclude: ReadonlySet<string> = new Set()): string | null {
    if (this.ids.length === 0) return null
    for (let attempts = 0; attempts < this.ids.length + 1; attempts++) {
      if (this.bag.length === 0) this.bag = shuffle(this.ids)
      const id = this.bag.pop()!
      if (!exclude.has(id) || this.ids.length <= exclude.size) return id
    }
    return this.bag.pop() ?? this.ids[0]
  }

  /** Upcoming ids for prefetch warming (non-destructive peek). */
  peek(n: number): string[] {
    const out = this.bag.slice(-n)
    return out.length >= n ? out.reverse() : shuffle(this.ids).slice(0, n)
  }
}
