import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  ConnectionStatus,
  PreviewResult,
  Source,
  WallpaperConfig
} from '../shared/types'

const api = {
  getConfig: (): Promise<{ config: AppConfig; hasApiKey: boolean }> =>
    ipcRenderer.invoke('config:get'),
  setServer: (baseUrl: string, apiKey: string): Promise<AppConfig> =>
    ipcRenderer.invoke('config:setServer', baseUrl, apiKey),
  setActive: (active: WallpaperConfig): Promise<AppConfig> =>
    ipcRenderer.invoke('config:setActive', active),
  savePreset: (name: string): Promise<AppConfig> => ipcRenderer.invoke('config:savePreset', name),
  loadPreset: (name: string): Promise<AppConfig> => ipcRenderer.invoke('config:loadPreset', name),
  deletePreset: (name: string): Promise<AppConfig> =>
    ipcRenderer.invoke('config:deletePreset', name),

  testConnection: (baseUrl: string, apiKey: string): Promise<ConnectionStatus> =>
    ipcRenderer.invoke('connection:test', baseUrl, apiKey),
  status: (): Promise<{ connected: boolean; paused: boolean; error: string | null }> =>
    ipcRenderer.invoke('connection:status'),
  onStatusChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('status:changed', listener)
    return () => ipcRenderer.removeListener('status:changed', listener)
  },

  people: (): Promise<Array<{ id: string; name: string }>> => ipcRenderer.invoke('immich:people'),
  albums: (): Promise<Array<{ id: string; albumName: string; assetCount: number }>> =>
    ipcRenderer.invoke('immich:albums'),
  tags: (): Promise<Array<{ id: string; name: string }>> => ipcRenderer.invoke('immich:tags'),

  preview: (source: Source): Promise<PreviewResult> => ipcRenderer.invoke('source:preview', source),
  applyNow: (): Promise<void> => ipcRenderer.invoke('wallpaper:applyNow'),
  setPaused: (paused: boolean): Promise<{ paused: boolean }> =>
    ipcRenderer.invoke('wallpaper:setPaused', paused),
  setLaunchAtLogin: (enabled: boolean): Promise<{ launchAtLogin: boolean }> =>
    ipcRenderer.invoke('app:setLaunchAtLogin', enabled)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
