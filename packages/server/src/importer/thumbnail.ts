// Runs only in a format worker. Native decoding/encoding is bounded by that pool, with
// one libvips thread per job. Paths have already passed ownership checks on the main thread.
import sharp from "sharp"
import { randomUUID } from "node:crypto"
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { isMediaPath } from "../db/media.ts"
import { type AvatarCrop, cropKey, cropPixels, defaultCrop, MEDIA_WIDTHS } from "@rp/shared/media.ts"
import { ThumbnailFailed } from "./ops.ts"

sharp.concurrency(1)
sharp.cache(false)

const MAX_INPUT_PIXELS = 40_000_000

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

const write = async (target: string, output: Buffer) => {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, output, { flag: "wx", mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Makes the derivatives of `path` at `widths` that aren't on disk yet, from one decode.
 * Answers, per width, the file to serve: its derivative, or the original when the image is
 * animated, too large, or too slow to resize (remembered by a `.original-v1` marker).
 * With `crop`, a portrait's cutout (§14.5c; null: the default, from the image's own shape):
 * the 2:3 part of the image, named in the file, so a changed cutout is another file and ETag.
 */
const derive = async (dataDir: string, path: string, widths: ReadonlyArray<number>, crop?: AvatarCrop | null) => {
  if (!isMediaPath(path)) throw new Error("invalid media path")
  const original = join(dataDir, path)
  const cut = crop === undefined ? "" : `-c${cropKey(crop)}`
  const relative = (width: number) => `${path}.thumb-v1-${width}${cut}.webp`
  const missing: Array<number> = []
  for (const width of widths) if (!(await exists(join(dataDir, relative(width))))) missing.push(width)
  const done = new Map(
    widths.filter((w) => !missing.includes(w)).map((w) => [w, { path: relative(w), original: false }])
  )
  if (missing.length === 0) return done
  const fallback = () => new Map(widths.map((w) => [w, { path, original: true }]))
  // Remember original fallbacks across widths and restarts. Keep reading markers
  // written by the previous animation-only implementation too.
  const marker = `${original}.original-v1`
  if (await Promise.all([marker, `${original}.animated-v1`].map(exists)).then((found) => found.some(Boolean)))
    return fallback()
  const bytes = await readFile(original)
  // metadata() reads headers without decoding pixels. Only this inspection is
  // unlimited; the actual resize below retains the memory-safety limit.
  const metadata = await sharp(bytes, { limitInputPixels: false }).metadata()
  const useOriginal = async () => {
    await writeFile(marker, "", { mode: 0o600 })
    return fallback()
  }
  // libvips reports GIF/WebP pages. Inspect PNG chunk boundaries for APNG's acTL:
  // older libvips versions don't consistently expose APNG pages in metadata.
  let animated = (metadata.pages ?? 1) > 1
  if (metadata.format === "png") {
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(at)
      if (bytes.toString("ascii", at + 4, at + 8) === "acTL") animated = true
      at += length + 12
    }
  }
  if (animated || (metadata.width ?? 0) * (metadata.height ?? 0) > MAX_INPUT_PIXELS) return useOriginal()
  // One decode for every width: the pixels once, each size resized from them.
  let decoded: { data: Buffer; info: { width: number; height: number; channels: 1 | 2 | 3 | 4 } }
  try {
    decoded = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .raw()
      // Finish before the format pool's 30-second worker deadline.
      .timeout({ seconds: 20 })
      .toBuffer({ resolveWithObject: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes("timeout")) return useOriginal()
    throw error
  }
  const { width, height, channels } = decoded.info
  // The cutout in the oriented image's pixels, exactly 2:3; the whole image without one.
  const region = crop === undefined ? null : cropPixels(crop ?? defaultCrop(width, height), width, height)
  for (const target of missing) {
    const image = sharp(decoded.data, { raw: { width, height, channels }, limitInputPixels: MAX_INPUT_PIXELS })
    if (region !== null) image.extract(region)
    // Never enlarged: a cutout narrower than the width asked for stays its own size.
    const output = await image
      .resize(
        region === null
          ? { width: target, withoutEnlargement: true }
          : {
              width: Math.min(target, region.width),
              height: Math.round((Math.min(target, region.width) * 3) / 2),
              fit: "cover"
            }
      )
      .webp({ quality: 80 })
      .toBuffer()
    await write(join(dataDir, relative(target)), output)
    done.set(target, { path: relative(target), original: false })
  }
  return done
}

export const thumbnail = (input: { dataDir: string; path: string; width: number; crop?: AvatarCrop | null }) =>
  Effect.tryPromise({
    try: async () => (await derive(input.dataDir, input.path, [input.width], input.crop)).get(input.width)!,
    catch: () => new ThumbnailFailed()
  })

/**
 * The widths made ahead when an image is stored: the grid's tiles and the lists' avatars at
 * 1× and 2×. 768 (a 3× phone's tile) is made on its first request: it alone took about
 * 450 ms of a card's 600 ms, measured on a 2.4 MB portrait, which tripled an ST import's time per card.
 */
const PREPARED_WIDTHS = MEDIA_WIDTHS.filter((width) => width <= 384)

/**
 * The widths of PREPARED_WIDTHS not on disk yet, e.g. when an import stores a card's image: of
 * the cutout its portraits show (null: the default), which is what the lists and grid ask for.
 */
export const prepareThumbnails = (input: { dataDir: string; path: string; crop: AvatarCrop | null }) =>
  Effect.tryPromise({
    try: async () => void (await derive(input.dataDir, input.path, PREPARED_WIDTHS, input.crop)),
    catch: () => new ThumbnailFailed()
  })
