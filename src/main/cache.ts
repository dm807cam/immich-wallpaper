import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import type { ImmichClient } from './immich'

interface Entry {
  path: string
  size: number
  lastUsed: number
}

const MAX_BYTES = 500 * 1024 * 1024 // 500 MB
const MAX_FILES = 300

/** Downloads original assets to a temp dir and keeps an LRU on disk. */
export class AssetCache {
  private readonly dir = join(app.getPath('temp'), 'immich-wallpaper', 'cache')
  private readonly entries = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<string>>()
  private ready: Promise<void>

  constructor() {
    this.ready = fs
      .mkdir(this.dir, { recursive: true })
      .then(() => this.scanExisting())
      .then(() => {})
  }

  /** Populate entries from files already on disk (from previous sessions). */
  private async scanExisting(): Promise<void> {
    let files: string[]
    try {
      files = await fs.readdir(this.dir)
    } catch {
      return
    }
    await Promise.all(
      files
        .filter((f) => f.endsWith('.bin'))
        .map(async (f) => {
          const id = basename(f, '.bin')
          const path = join(this.dir, f)
          try {
            const stat = await fs.stat(path)
            this.entries.set(id, { path, size: stat.size, lastUsed: stat.mtimeMs })
          } catch {
            // file disappeared between readdir and stat — skip
          }
        })
    )
    // Enforce limits on the restored set so a large prior session doesn't
    // exceed the cap before any new downloads happen.
    await this.evictIfNeeded()
  }

  /** Return a local file path for an asset, downloading via `client` if absent. */
  async get(id: string, client: ImmichClient): Promise<string> {
    await this.ready
    const hit = this.entries.get(id)
    if (hit) {
      hit.lastUsed = Date.now()
      return hit.path
    }
    const existing = this.inflight.get(id)
    if (existing) return existing

    const task = (async () => {
      const buf = await client.renderImage(id)
      const path = join(this.dir, `${id}.bin`)
      await fs.writeFile(path, buf)
      this.entries.set(id, { path, size: buf.length, lastUsed: Date.now() })
      await this.evictIfNeeded()
      return path
    })().finally(() => this.inflight.delete(id))

    this.inflight.set(id, task)
    return task
  }

  /** Warm the cache for upcoming ids in the background; failures are ignored. */
  prefetch(ids: string[], client: ImmichClient): void {
    for (const id of ids) {
      if (this.entries.has(id) || this.inflight.has(id)) continue
      void this.get(id, client).catch(() => {})
    }
  }

  private async evictIfNeeded(): Promise<void> {
    let total = 0
    for (const e of this.entries.values()) total += e.size
    if (total <= MAX_BYTES && this.entries.size <= MAX_FILES) return

    const ordered = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [id, e] of ordered) {
      if (total <= MAX_BYTES && this.entries.size <= MAX_FILES) break
      this.entries.delete(id)
      total -= e.size
      await fs.rm(e.path, { force: true })
    }
  }
}
