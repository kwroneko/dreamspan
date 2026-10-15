// Runs only in a format worker. Native decoding/encoding is bounded by that pool, with
// one libvips thread per job. Paths have already passed ownership checks on the main thread.
import sharp from "sharp"
import { randomUUID } from "node:crypto"
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { isMediaPath } from "../db/media.ts"
import { ThumbnailFailed } from "./ops.ts"

sharp.concurrency(1)
sharp.cache(false)

const MAX_INPUT_PIXELS = 40_000_000

export const thumbnail = (input: { dataDir: string; path: string; width: number }) =>
  Effect.tryPromise({
    try: async () => {
      if (!isMediaPath(input.path)) throw new Error("invalid media path")
      const original = join(input.dataDir, input.path)
      const relative = `${input.path}.thumb-v1-${input.width}.webp`
      const target = join(input.dataDir, relative)
      if (
        await stat(target).then(
          () => true,
          () => false
        )
      )
        return { path: relative, original: false }
      // Remember original fallbacks across widths and restarts. Keep reading markers
      // written by the previous animation-only implementation too.
      const marker = `${original}.original-v1`
      if (
        await Promise.all(
          [marker, `${original}.animated-v1`].map((path) =>
            stat(path).then(
              () => true,
              () => false
            )
          )
        ).then((found) => found.some(Boolean))
      )
        return { path: input.path, original: true }
      const bytes = await readFile(original)
      // metadata() reads headers without decoding pixels. Only this inspection is
      // unlimited; the actual resize below retains the memory-safety limit.
      const metadata = await sharp(bytes, { limitInputPixels: false }).metadata()
      const useOriginal = async () => {
        await writeFile(marker, "", { mode: 0o600 })
        return { path: input.path, original: true }
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
      let output: Buffer
      try {
        output = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
          .rotate()
          .resize({ width: input.width, withoutEnlargement: true })
          .webp({ quality: 80 })
          // Finish before the format pool's 30-second worker deadline.
          .timeout({ seconds: 20 })
          .toBuffer()
      } catch (error) {
        if (error instanceof Error && error.message.includes("timeout")) return useOriginal()
        throw error
      }
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, output, { flag: "wx", mode: 0o600 })
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
      return { path: relative, original: false }
    },
    catch: () => new ThumbnailFailed()
  })
