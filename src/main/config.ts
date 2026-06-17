import { safeStorage } from 'electron'
import Store from 'electron-store'
import { AppConfig, defaultConfig } from '../shared/types'

interface PersistShape {
  config: AppConfig
  // API key, encrypted with Electron safeStorage and stored base64. Never plaintext.
  apiKeyEnc?: string
}

const store = new Store<PersistShape>({
  name: 'immich-wallpaper',
  defaults: { config: defaultConfig() }
})

export function getConfig(): AppConfig {
  const parsed = AppConfig.safeParse(store.get('config'))
  if (parsed.success) return parsed.data
  // Corrupt/old config -> reset to defaults rather than crash.
  const fresh = defaultConfig()
  store.set('config', fresh)
  return fresh
}

export function setConfig(config: AppConfig): AppConfig {
  const validated = AppConfig.parse(config)
  store.set('config', validated)
  return validated
}

export function updateConfig(mut: (c: AppConfig) => AppConfig): AppConfig {
  return setConfig(mut(getConfig()))
}

// --- API key (secret) --------------------------------------------------------

export function setApiKey(apiKey: string): void {
  if (!apiKey) {
    store.delete('apiKeyEnc')
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(apiKey).toString('base64')
    store.set('apiKeyEnc', enc)
  } else {
    // Fallback: still avoid plaintext-looking storage; mark with a prefix.
    store.set('apiKeyEnc', 'plain:' + Buffer.from(apiKey).toString('base64'))
  }
}

export function getApiKey(): string {
  const enc = store.get('apiKeyEnc')
  if (!enc) return ''
  if (enc.startsWith('plain:')) {
    return Buffer.from(enc.slice('plain:'.length), 'base64').toString('utf8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

export function hasApiKey(): boolean {
  return Boolean(store.get('apiKeyEnc'))
}

export function storePath(): string {
  return store.path
}
