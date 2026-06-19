import { app, ipcMain } from 'electron'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getApiKey, getConfig, hasApiKey, setApiKey, updateConfig } from './config'
import { normalizeBaseUrl } from './immich'
import type { Controller } from './controller'
import { WallpaperConfig, Source } from '../shared/types'

function applyLinuxAutostart(enabled: boolean): void {
  const dir = join(homedir(), '.config', 'autostart')
  const file = join(dir, 'immich-wallpaper.desktop')
  if (enabled) {
    mkdirSync(dir, { recursive: true })
    // Inside an AppImage, process.execPath is the transient extracted binary under
    // /tmp/.mount_XXX which is gone after unmount. The AppImage runtime exports the
    // persistent .AppImage path in APPIMAGE instead.
    const execPath = process.env['APPIMAGE'] ?? process.execPath
    writeFileSync(
      file,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Immich Wallpaper',
        `Exec="${execPath}"`,
        'Hidden=false',
        'NoDisplay=false',
        'X-GNOME-Autostart-enabled=true'
      ].join('\n') + '\n',
      'utf8'
    )
  } else {
    try {
      unlinkSync(file)
    } catch {
      // already absent
    }
  }
}

/**
 * Register (or clear) the OS "start at login" item.
 * - macOS/Windows: uses Electron's login-item API (launches hidden on macOS).
 * - Linux: writes/removes an XDG autostart .desktop file.
 */
export function applyLoginItem(enabled: boolean): void {
  if (process.platform === 'linux') {
    applyLinuxAutostart(enabled)
    return
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32') return
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
}

export function registerIpc(controller: Controller): void {
  ipcMain.handle('config:get', () => ({ config: getConfig(), hasApiKey: hasApiKey() }))

  ipcMain.handle('config:setServer', async (_e, baseUrl: string, apiKey: string) => {
    updateConfig((c) => ({ ...c, server: { baseUrl: normalizeBaseUrl(baseUrl) } }))
    if (apiKey) setApiKey(apiKey)
    await controller.reload(true)
    return getConfig()
  })

  ipcMain.handle('config:setActive', async (_e, active: unknown) => {
    const parsed = WallpaperConfig.parse(active)
    updateConfig((c) => ({ ...c, active: parsed }))
    await controller.reload(true)
    return getConfig()
  })

  ipcMain.handle('config:savePreset', (_e, name: string) => {
    return updateConfig((c) => ({ ...c, presets: { ...c.presets, [name]: c.active } }))
  })
  ipcMain.handle('config:loadPreset', async (_e, name: string) => {
    const preset = getConfig().presets[name]
    if (preset) {
      updateConfig((c) => ({ ...c, active: preset }))
      await controller.reload(true)
    }
    return getConfig()
  })
  ipcMain.handle('config:deletePreset', (_e, name: string) => {
    return updateConfig((c) => {
      const presets = { ...c.presets }
      delete presets[name]
      return { ...c, presets }
    })
  })

  ipcMain.handle('connection:test', (_e, baseUrl: string, apiKey: string) => {
    // Fall back to saved values when a field is left blank (key field shows a
    // placeholder when already saved), so Test works without re-typing the key.
    const cfg = getConfig()
    const url = baseUrl?.trim() || cfg.server.baseUrl
    const key = apiKey?.trim() || getApiKey()
    return controller.testConnection(url, key)
  })
  ipcMain.handle('connection:status', () => ({
    connected: controller.isConnected,
    paused: controller.isPaused,
    error: controller.error
  }))

  ipcMain.handle('immich:people', () => controller.buildClient()?.people() ?? [])
  ipcMain.handle('immich:albums', () => controller.buildClient()?.albums() ?? [])
  ipcMain.handle('immich:tags', () => controller.buildClient()?.tags() ?? [])

  ipcMain.handle('source:preview', (_e, raw: unknown) => controller.preview(Source.parse(raw)))

  ipcMain.handle('wallpaper:applyNow', () => controller.applyNow())
  ipcMain.handle('wallpaper:setPaused', (_e, paused: boolean) => {
    updateConfig((c) => ({ ...c, paused }))
    controller.setPaused(paused)
    return { paused: controller.isPaused }
  })

  ipcMain.handle('app:setLaunchAtLogin', (_e, enabled: boolean) => {
    updateConfig((c) => ({ ...c, launchAtLogin: enabled }))
    applyLoginItem(enabled)
    return { launchAtLogin: enabled }
  })
}
