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
      // Remember animation too, so every repeat request avoids decoding the original.
      const marker = `${original}.animated-v1`
      if (
        await stat(marker).then(
          () => true,
          () => false
        )
      )
        return { path: input.path, original: true }
      const bytes = await readFile(original)
      const image = sharp(bytes, { limitInputPixels: 40_000_000 })
      const metadata = await image.metadata()
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
      if (animated) {
        await writeFile(marker, "", { mode: 0o600 })
        return { path: input.path, original: true }
      }
      const output = await image
        .rotate()
        .resize({ width: input.width, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
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
