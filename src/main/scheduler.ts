import { powerMonitor } from 'electron'
import { intervalToMs, type WallpaperConfig } from '../shared/types'
import type { WallpaperEngine } from './render'

interface Task {
  label: string
  intervalMs: number
  nextFire: number
  timer: NodeJS.Timeout | null
  fn: () => Promise<void>
}

/** Drives the engine on independent per-cell (or single) timers. */
export class Scheduler {
  private tasks: Task[] = []
  private paused = false

  constructor(
    private readonly engine: WallpaperEngine,
    private readonly onResult?: (error: Error | null) => void
  ) {
    powerMonitor.on('resume', () => this.handleResume())
  }

  /** Rebuild timers for a config. Intervals fire *after* one period (initial paint is separate). */
  build(config: WallpaperConfig): void {
    this.clear()
    const now = Date.now()
    if (config.mode === 'single') {
      const ms = intervalToMs(config.interval)
      this.tasks.push(this.makeTask('single', ms, now, () => this.engine.renderSingle()))
    } else {
      // All tiles refresh together on one timer: a single full re-composite per
      // cycle instead of one per tile.
      const ms = intervalToMs(config.interval)
      this.tasks.push(this.makeTask('collage', ms, now, () => this.engine.advanceAllCells()))
    }
    if (!this.paused) this.armAll()
  }

  private makeTask(label: string, intervalMs: number, now: number, fn: () => Promise<void>): Task {
    return { label, intervalMs, nextFire: now + intervalMs, timer: null, fn }
  }

  private armAll(): void {
    for (const t of this.tasks) this.arm(t)
  }

  private arm(task: Task): void {
    if (task.timer) clearTimeout(task.timer)
    const delay = Math.max(0, task.nextFire - Date.now())
    task.timer = setTimeout(() => void this.fire(task), delay)
  }

  private async fire(task: Task): Promise<void> {
    task.nextFire = Date.now() + task.intervalMs
    if (!this.paused) this.arm(task)
    try {
      await task.fn()
      this.onResult?.(null)
    } catch (e) {
      console.error(`[scheduler:${task.label}]`, e)
      this.onResult?.(e instanceof Error ? e : new Error(String(e)))
    }
  }

  /** After sleep, fire any task whose interval elapsed while suspended (once). */
  private handleResume(): void {
    if (this.paused) return
    const now = Date.now()
    for (const t of this.tasks) {
      if (now >= t.nextFire) void this.fire(t)
      else this.arm(t)
    }
  }

  pause(): void {
    this.paused = true
    for (const t of this.tasks) {
      if (t.timer) clearTimeout(t.timer)
      t.timer = null
    }
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    const now = Date.now()
    for (const t of this.tasks) t.nextFire = now + t.intervalMs
    this.armAll()
  }

  get isPaused(): boolean {
    return this.paused
  }

  clear(): void {
    for (const t of this.tasks) if (t.timer) clearTimeout(t.timer)
    this.tasks = []
  }
}
