// Runs only in a format worker. Native decoding/encoding is bounded by that pool, with
// one libvips thread per job. Paths have already passed ownership checks on the main thread.
import sharp from "sharp"
import { randomUUID } from "node:crypto"
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { isMediaPath } from "../db/media.ts"
import { MEDIA_WIDTHS } from "@rp/shared/media.ts"
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
 */
const derive = async (dataDir: string, path: string, widths: ReadonlyArray<number>) => {
  if (!isMediaPath(path)) throw new Error("invalid media path")
  const original = join(dataDir, path)
  const relative = (width: number) => `${path}.thumb-v1-${width}.webp`
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
  for (const target of missing) {
    const output = await sharp(decoded.data, { raw: { width, height, channels }, limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: target, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()
    await write(join(dataDir, relative(target)), output)
    done.set(target, { path: relative(target), original: false })
  }
  return done
}

export const thumbnail = (input: { dataDir: string; path: string; width: number }) =>
  Effect.tryPromise({
    try: async () => (await derive(input.dataDir, input.path, [input.width])).get(input.width)!,
    catch: () => new ThumbnailFailed()
  })

/**
 * The widths made ahead when an image is stored: the grid's tiles and the lists' avatars at
 * 1× and 2×. 768 (a 3× phone's tile) is made on its first request: it alone took about
 * 450 ms of a card's 600 ms, measured on a 2.4 MB portrait, which tripled an ST import's time per card.
 */
export const PREPARED_WIDTHS = MEDIA_WIDTHS.filter((width) => width <= 384)

/** The widths of PREPARED_WIDTHS not on disk yet, e.g. when an import stores a card's image. */
export const prepareThumbnails = (input: { dataDir: string; path: string }) =>
  Effect.tryPromise({
    try: async () => void (await derive(input.dataDir, input.path, PREPARED_WIDTHS)),
    catch: () => new ThumbnailFailed()
  })
