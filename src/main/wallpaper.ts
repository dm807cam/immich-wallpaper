// The `wallpaper` package is ESM-only; load it lazily via dynamic import so this
// module works regardless of whether the main bundle is emitted as CJS or ESM.
type WallpaperModule = typeof import('wallpaper')

let mod: WallpaperModule | null = null
async function load(): Promise<WallpaperModule> {
  if (!mod) mod = await import('wallpaper')
  return mod
}

/** Apply `imagePath` as the desktop wallpaper on every connected display. */
export async function setWallpaperAllDisplays(imagePath: string): Promise<void> {
  const w = await load()
  await w.setWallpaper(imagePath, { screen: 'all' })
}
