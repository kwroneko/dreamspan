// A stand-in for saved card media's downloads (spec/SAVED-MEDIA.md §3.3), for browser tests and
// previews: `FAKE_SAVED_MEDIA=on` answers every approved address with a synthetic 1×1 PNG and
// never touches the network. The server tests exercise the real fetcher.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { SavedMedia } from "../api/savedMedia.ts"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64"
)

/** Whether a `FAKE_SAVED_MEDIA` value asks for the stand-in. */
export const fakeSavedMediaWanted = (value: string | undefined) => value === "on"

/** Replaces the fetcher of the server it's provided over. */
export const fakeSavedMedia = Layer.effectDiscard(
  Effect.flatMap(SavedMedia, (saved) =>
    saved.fetchers.register({
      id: "media.saved",
      fetch: async (_url, _signal, options = {}) => {
        if (options.allowHost && !options.allowHost(new URL(_url).hostname.toLowerCase()))
          throw new Error("It moved to a site you haven't approved.")
        const dir = await mkdtemp(join(tmpdir(), "rp-fake-media-"))
        const path = join(dir, "file")
        await writeFile(path, PNG)
        return { path, mime: "image/png", dispose: () => rm(dir, { recursive: true, force: true }) }
      }
    })
  )
)
