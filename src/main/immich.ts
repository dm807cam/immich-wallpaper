import { Source } from '../shared/types'

export interface ImmichAsset {
  id: string
  type?: string
  originalFileName?: string
  people?: Array<{ id: string; name?: string }>
  tags?: Array<{ id: string; name?: string }>
}

interface SearchResponse {
  assets?: { items?: ImmichAsset[]; total?: number; nextPage?: string | number | null }
}

const MAX_PAGE_SIZE = 1000 // Immich caps search page size at 1000
const SPREAD_PAGE = 100 // small pages so random page sampling spreads across the timeline
const SPREAD_CONCURRENCY = 4 // max parallel page fetches during pool build

function shuffleInPlace<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
}

/** Face bounding box normalized to [0,1] of the oriented image. */
export interface FaceBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface RawFace {
  imageWidth?: number
  imageHeight?: number
  boundingBoxX1?: number
  boundingBoxY1?: number
  boundingBoxX2?: number
  boundingBoxY2?: number
}

/** Normalize a user-entered base URL to a clean `http(s)://host[:port]` root (no trailing /api, no slash). */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  url = url.replace(/\/api$/i, '')
  return url
}

export class ImmichClient {
  private readonly root: string
  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.root = normalizeBaseUrl(baseUrl)
  }

  private url(path: string): string {
    return `${this.root}/api${path}`
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      'x-api-key': this.apiKey,
      Accept: 'application/json'
    }
    if (json) h['Content-Type'] = 'application/json'
    return h
  }

  /**
   * fetch() that retries on *network* failures (the undici "fetch failed" / reset
   * blips), with a short backoff. HTTP error statuses are returned as-is — only
   * connection-level errors are retried.
   */
  private async doFetch(url: string, init?: RequestInit, tries = 3): Promise<Response> {
    let lastErr: unknown
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        return await fetch(url, init)
      } catch (e) {
        lastErr = e
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.doFetch(this.url(path), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${res.statusText}`)
    return (await res.json()) as T
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.doFetch(this.url(path), { headers: this.headers() })
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`)
    return (await res.json()) as T
  }

  // --- connection / metadata pickers ----------------------------------------

  async me(): Promise<{ name: string; email: string }> {
    return this.get('/users/me')
  }

  async statistics(): Promise<{ images?: number; videos?: number; total?: number }> {
    try {
      return await this.get('/assets/statistics')
    } catch {
      return {}
    }
  }

  async people(): Promise<Array<{ id: string; name: string }>> {
    const res = await this.get<{ people?: Array<{ id: string; name: string }> }>(
      '/people?withHidden=false&size=1000'
    )
    return (res.people ?? []).filter((p) => p.name)
  }

  async albums(): Promise<Array<{ id: string; albumName: string; assetCount: number }>> {
    return this.get('/albums')
  }

  async tags(): Promise<Array<{ id: string; name: string }>> {
    return this.get('/tags')
  }

  // --- search ---------------------------------------------------------------

  /** Resolve a Source into a pool of up to `size` asset ids (images only). */
  async resolvePool(source: Source, size = 100): Promise<string[]> {
    if (source.kind === 'random') return this.resolveRandom(source, size)

    // Person: Immich's personIds filter is AND (assets containing *all* listed
    // people) — for multiple people that intersection is tiny and repeats fast.
    // Query each person separately and union, so photos of *any* selected person
    // appear. Each query is timeline-spread (not just newest).
    if (source.kind === 'person') {
      const people = source.personIds
      if (people.length <= 1) return this.resolveSpread({ personIds: people, type: 'IMAGE' }, size)
      const per = Math.ceil(size / people.length)
      const union = new Set<string>()
      for (const pid of people) {
        const part = await this.resolveSpread({ personIds: [pid], type: 'IMAGE' }, per)
        for (const id of part) union.add(id)
      }
      const arr = [...union]
      shuffleInPlace(arr)
      return arr.slice(0, size)
    }

    // Theme: CLIP smart search is ranked by relevance (not date) — keep top-N.
    const base = {
      query: source.query,
      personIds: source.personIds,
      tagIds: source.tagIds,
      albumIds: source.albumIds,
      type: 'IMAGE'
    }
    const ids = new Set<string>()
    let page = 1
    while (ids.size < size) {
      const res = await this.post<SearchResponse>('/search/smart', {
        ...base,
        size: Math.min(MAX_PAGE_SIZE, size),
        page
      })
      const items = res.assets?.items ?? []
      for (const a of items) if ((a.type ?? 'IMAGE') === 'IMAGE') ids.add(a.id)
      const next = res.assets?.nextPage
      if (!next || items.length === 0) break
      const parsed = Number(next)
      page = Number.isFinite(parsed) && parsed > page ? parsed : page + 1
    }
    return [...ids].slice(0, size)
  }

  /**
   * Build a pool that spans the entire matching set rather than just the newest
   * results. Probes the total match count, then samples random pages across the
   * *full* range (page 1 only by chance) — so no fixed slice of recent photos is
   * always present, and a person's photos from every year can surface.
   */
  private async resolveSpread(base: Record<string, unknown>, size: number): Promise<string[]> {
    const ids = new Set<string>()
    const collect = (items?: ImmichAsset[]): void => {
      for (const a of items ?? []) if ((a.type ?? 'IMAGE') === 'IMAGE') ids.add(a.id)
    }

    // Lightweight probe just to learn the total; don't pull the newest page here.
    const probe = await this.post<SearchResponse>('/search/metadata', { ...base, size: 1, page: 1 })
    const total = probe.assets?.total ?? 0
    if (total <= 0) {
      collect(probe.assets?.items)
      return [...ids].slice(0, size)
    }

    const numPages = Math.max(1, Math.ceil(total / SPREAD_PAGE))
    const pages = Array.from({ length: numPages }, (_, i) => i + 1)
    shuffleInPlace(pages)
    const wantPages = Math.min(numPages, Math.ceil(size / SPREAD_PAGE))
    const selected = pages.slice(0, wantPages)

    // Fetch pages with bounded concurrency to avoid a burst of parallel requests.
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < selected.length) {
        const p = selected[cursor++]
        try {
          const res = await this.post<SearchResponse>('/search/metadata', {
            ...base,
            size: SPREAD_PAGE,
            page: p
          })
          collect(res.assets?.items)
        } catch {
          /* best-effort: skip a page that fails, keep the ids we have */
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(SPREAD_CONCURRENCY, selected.length) }, worker)
    )
    return [...ids].slice(0, size)
  }

  /** Random pool: /search/random is non-paginated, so sample repeatedly and dedupe. */
  private async resolveRandom(
    source: Extract<Source, { kind: 'random' }>,
    size: number
  ): Promise<string[]> {
    const ids = new Set<string>()
    const want = Math.min(MAX_PAGE_SIZE, size)
    for (let attempt = 0; ids.size < size && attempt < 6; attempt++) {
      const res = await this.post<ImmichAsset[]>('/search/random', {
        type: 'IMAGE',
        size: want,
        ...(source.favoritesOnly ? { isFavorite: true } : {})
      })
      const arr = Array.isArray(res) ? res : []
      if (arr.length === 0) break
      for (const a of arr) if ((a.type ?? 'IMAGE') === 'IMAGE') ids.add(a.id)
      if (arr.length < want) break // library smaller than the request
    }
    return [...ids]
  }

  /** Fetch full asset metadata (used to enrich collage similarity with people/tags). */
  async asset(id: string): Promise<ImmichAsset> {
    return this.get(`/assets/${id}`)
  }

  /**
   * Detected face boxes for an asset, normalized to [0,1] of the (oriented) image.
   * Returns [] when face recognition is off or the asset has no faces. Best-effort:
   * any error yields [] so cropping silently falls back to centre.
   */
  async faces(id: string): Promise<FaceBox[]> {
    try {
      const res = await this.get<RawFace[]>(`/faces?id=${id}`)
      const out: FaceBox[] = []
      for (const f of res ?? []) {
        const iw = f.imageWidth ?? 0
        const ih = f.imageHeight ?? 0
        if (iw <= 0 || ih <= 0) continue
        const ax = (f.boundingBoxX1 ?? 0) / iw
        const ay = (f.boundingBoxY1 ?? 0) / ih
        const bx = (f.boundingBoxX2 ?? 0) / iw
        const by = (f.boundingBoxY2 ?? 0) / ih
        out.push({ x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) })
      }
      return out
    } catch {
      return []
    }
  }

  /**
   * Immich-rendered JPEG bytes for an asset (the "preview" render, bounded size).
   * Used as the wallpaper source: a screen is ~5K, so the multi-MB original is
   * wasted work — the preview bounds memory + decode time and is already a
   * sharp-decodable JPEG (no HEIC/HEVC decoder needed).
   */
  async renderImage(id: string): Promise<Buffer> {
    const res = await this.doFetch(this.url(`/assets/${id}/thumbnail?size=preview`), {
      headers: this.headers(false)
    })
    if (!res.ok) throw new Error(`render ${id} -> ${res.status} ${res.statusText}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** Download a small thumbnail (for UI previews). Returns a base64 data URL. */
  async thumbnailDataUrl(id: string): Promise<string> {
    const res = await this.doFetch(this.url(`/assets/${id}/thumbnail?size=thumbnail`), {
      headers: this.headers(false)
    })
    if (!res.ok) throw new Error(`thumbnail ${id} -> ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const ct = res.headers.get('content-type') ?? 'image/jpeg'
    return `data:${ct};base64,${buf.toString('base64')}`
  }
}
