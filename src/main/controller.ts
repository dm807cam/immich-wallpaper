import { getApiKey, getConfig, hasApiKey } from './config'
import { ImmichClient } from './immich'
import { WallpaperEngine } from './render'
import { Scheduler } from './scheduler'
import type { ConnectionStatus, PreviewResult, Source } from '../shared/types'

/**
 * Top-level orchestrator. Owns the engine + scheduler and rebuilds them from
 * the persisted config. Used by both the IPC layer and the tray menu.
 */
export class Controller {
  readonly engine = new WallpaperEngine()
  readonly scheduler = new Scheduler(this.engine, (err) => this.setError(err))
  private onChange: (() => void) | null = null
  private lastError: string | null = null

  setOnChange(cb: () => void): void {
    this.onChange = cb
  }
  private emit(): void {
    this.onChange?.()
  }

  /** Record (or clear) the most recent rotation error and notify listeners on change. */
  private setError(err: Error | null): void {
    const next = err ? err.message : null
    if (next === this.lastError) return
    this.lastError = next
    this.emit()
  }

  get error(): string | null {
    return this.lastError
  }

  buildClient(): ImmichClient | null {
    const cfg = getConfig()
    const key = getApiKey()
    if (!cfg.server.baseUrl || !key) return null
    return new ImmichClient(cfg.server.baseUrl, key)
  }

  /** Re-read config, rebuild client/engine/scheduler. Optionally repaint immediately. */
  async reload(applyNow = false): Promise<void> {
    const cfg = getConfig()
    this.engine.setClient(this.buildClient())
    this.engine.setConfig(cfg.active)
    this.scheduler.build(cfg.active)
    if (cfg.paused) this.scheduler.pause()
    if (applyNow && this.engine.hasClient()) {
      await this.applyNow()
    }
    this.emit()
  }

  async applyNow(): Promise<void> {
    if (!this.engine.hasClient()) return
    try {
      await this.engine.applyNow()
      this.setError(null)
    } catch (e) {
      console.error('[applyNow]', e)
      this.setError(e instanceof Error ? e : new Error(String(e)))
    }
  }

  setPaused(paused: boolean): void {
    if (paused) this.scheduler.pause()
    else this.scheduler.resume()
    this.emit()
  }

  get isPaused(): boolean {
    return this.scheduler.isPaused
  }
  get isConnected(): boolean {
    return Boolean(getConfig().server.baseUrl) && hasApiKey()
  }

  // --- helpers used by IPC ---------------------------------------------------

  async testConnection(baseUrl: string, apiKey: string): Promise<ConnectionStatus> {
    try {
      const client = new ImmichClient(baseUrl, apiKey)
      const me = await client.me()
      const stats = await client.statistics()
      return { ok: true, user: me.name || me.email, assetCount: stats.total ?? stats.images }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async preview(source: Source): Promise<PreviewResult> {
    const client = this.buildClient()
    if (!client) return { count: 0, samples: [] }
    const ids = await client.resolvePool(source, 60)
    const sampleIds = ids.slice(0, 6)
    const samples = await Promise.all(
      sampleIds.map((id) => client.thumbnailDataUrl(id).catch(() => ''))
    )
    return { count: ids.length, samples: samples.filter(Boolean) }
  }
}
