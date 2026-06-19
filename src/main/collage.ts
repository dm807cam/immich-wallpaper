import sharp from 'sharp'

export interface PositionedTile {
  /** Pre-resized tile pixels, already matching its destination cw×ch. */
  input: Buffer
  left: number
  top: number
}

/** A point in normalized [0,1] image coordinates to keep centered while cropping. */
export interface Focal {
  x: number
  y: number
}

interface Region {
  left: number
  top: number
  width: number
  height: number
}

/** Oriented (post-EXIF-rotate) pixel size of an image. */
export async function orientedSize(imagePath: string): Promise<{ w: number; h: number }> {
  const m = await sharp(imagePath).metadata()
  let w = m.width ?? 1
  let h = m.height ?? 1
  if (m.orientation && m.orientation >= 5) [w, h] = [h, w]
  return { w, h }
}

/** Largest crop window of aspect `w/h` inside `sw`×`sh`, centered on `focal`, clamped. */
function coverRegion(sw: number, sh: number, w: number, h: number, focal: Focal): Region {
  const targetAspect = w / h
  let cw: number
  let ch: number
  if (sw / sh > targetAspect) {
    ch = sh
    cw = Math.round(sh * targetAspect)
  } else {
    cw = sw
    ch = Math.round(sw / targetAspect)
  }
  cw = Math.min(sw, Math.max(1, cw))
  ch = Math.min(sh, Math.max(1, ch))
  const left = Math.min(sw - cw, Math.max(0, Math.round(focal.x * sw - cw / 2)))
  const top = Math.min(sh - ch, Math.max(0, Math.round(focal.y * sh - ch / 2)))
  return { left, top, width: cw, height: ch }
}

/**
 * Cover-fit one image to exactly `w`×`h`. Without `focal`, uses fast centre
 * gravity (the justified layout already matches each tile to its image's aspect
 * ratio, so centre cropping removes little). With `focal` (e.g. the centre of
 * detected faces), the cover crop window is shifted to keep that point in frame.
 * Avoids sharp's `attention`/`entropy` strategies, which run a slow saliency pass.
 */
export async function resizeTile(
  imagePath: string,
  w: number,
  h: number,
  focal?: Focal,
  srcSize?: { w: number; h: number }
): Promise<Buffer> {
  if (!focal) {
    return sharp(imagePath)
      .rotate() // honor EXIF orientation
      .resize(w, h, { fit: 'cover', position: 'centre' })
      .toBuffer()
  }
  const { w: sw, h: sh } = srcSize ?? (await orientedSize(imagePath))
  return sharp(imagePath)
    .rotate()
    .extract(coverRegion(sw, sh, w, h, focal))
    .resize(w, h)
    .toBuffer()
}

/** Composite already-positioned tiles onto a background canvas and write a JPEG. */
export async function composeCanvas(
  width: number,
  height: number,
  background: string,
  tiles: PositionedTile[],
  outPath: string
): Promise<string> {
  await sharp({
    create: { width, height, channels: 3, background }
  })
    .composite(tiles)
    .jpeg({ quality: 90 })
    .toFile(outPath)
  return outPath
}

/** Orientation-corrected aspect ratio (width / height) of an image file. */
export async function imageAspect(imagePath: string): Promise<number> {
  const { w, h } = await orientedSize(imagePath)
  return h > 0 ? w / h : 1
}

/** Cover-fit a single image to fill the canvas, optionally keeping `focal` in frame. */
export async function composeSingle(
  imagePath: string,
  width: number,
  height: number,
  outPath: string,
  focal?: Focal,
  srcSize?: { w: number; h: number }
): Promise<string> {
  const pipeline = sharp(imagePath).rotate()
  if (focal) {
    const { w: sw, h: sh } = srcSize ?? (await orientedSize(imagePath))
    pipeline.extract(coverRegion(sw, sh, width, height, focal)).resize(width, height)
  } else {
    pipeline.resize(width, height, { fit: 'cover', position: 'centre' })
  }
  await pipeline.jpeg({ quality: 92 }).toFile(outPath)
  return outPath
}
