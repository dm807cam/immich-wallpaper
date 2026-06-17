import { app, Menu, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { menubar } from 'menubar'
import { Controller } from './controller'
import { registerIpc, applyLoginItem } from './ipc'
import { getConfig, updateConfig } from './config'

const isDev = !app.isPackaged

function rendererIndex(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) return devUrl
  return pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
}

function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromPath(join(__dirname, '../../resources/trayTemplate.png'))
  // Template images auto-adapt to light/dark on macOS only.
  if (process.platform === 'darwin') img.setTemplateImage(true)
  return img
}

// Harden every web contents: this app only ever shows its own local UI, so deny
// all new windows and block navigation away from the bundled renderer.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
})

app.whenReady().then(() => {
  app.dock?.hide()

  // Register/refresh the OS login item to match persisted config (default: on).
  applyLoginItem(getConfig().launchAtLogin)

  const controller = new Controller()
  registerIpc(controller)

  const mb = menubar({
    index: rendererIndex(),
    icon: trayIcon(),
    tooltip: 'Immich Wallpaper',
    showDockIcon: false,
    preloadWindow: true,
    browserWindow: {
      width: 440,
      height: 660,
      resizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    }
  })

  function buildContextMenu(): Electron.Menu {
    const presets = Object.keys(getConfig().presets)
    return Menu.buildFromTemplate([
      { label: 'Next wallpaper now', click: () => void controller.applyNow() },
      {
        label: controller.isPaused ? 'Resume rotation' : 'Pause rotation',
        click: () => {
          const next = !controller.isPaused
          updateConfig((c) => ({ ...c, paused: next }))
          controller.setPaused(next)
        }
      },
      { type: 'separator' },
      {
        label: 'Switch preset',
        enabled: presets.length > 0,
        submenu: presets.map((name) => ({
          label: name,
          click: async () => {
            updateConfig((c) => ({ ...c, active: c.presets[name] }))
            await controller.reload(true)
          }
        }))
      },
      { label: 'Open settings…', click: () => mb.showWindow() },
      { type: 'separator' },
      {
        label: 'Immich Wallpaper — Help',
        click: () => void shell.openExternal('https://immich.app')
      },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' }
    ])
  }

  mb.on('ready', () => {
    mb.tray.on('right-click', () => mb.tray.popUpContextMenu(buildContextMenu()))

    // Reflect errors in the tray tooltip and push status to an open settings window.
    controller.setOnChange(() => {
      const err = controller.error
      mb.tray.setToolTip(err ? `Immich Wallpaper — error: ${err}` : 'Immich Wallpaper')
      mb.window?.webContents.send('status:changed')
    })

    void controller.reload(true)
  })
})

// Menu-bar app: stay alive when the popover window is hidden/closed.
app.on('window-all-closed', () => {})
