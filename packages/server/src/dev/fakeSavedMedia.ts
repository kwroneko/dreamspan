// A stand-in for saved card media's downloads (spec/SAVED-MEDIA.md §3.3), for browser tests and
// previews: `FAKE_SAVED_MEDIA=on` answers every approved address with a synthetic 1×1 PNG (a
// synthetic one-frame WebM for an address ending in `.webm`) and never touches the network. The server tests exercise the real fetcher.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { SavedMedia } from "../api/savedMedia.ts"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64"
)

/** A synthetic 16×16 one-frame VP8 WebM (made with ffmpeg's lavfi colour source). */
export const FAKE_WEBM = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHyEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggHc7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhAWQAAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIb7CulCXKqj+cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QF9eEA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PVY8CLY8WIb7CulCXKqj9nyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAxIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMTAwMDAwMDAwAB9DtnWm54EAo6GBAACAEAIAnQEqEAAQAABHCIWFiIWEiAICAAwOYAD+aAAcU7trkbuPs4EAt4r3gQHxggGx8IED",
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
        const video = new URL(_url).pathname.endsWith(".webm")
        await writeFile(path, video ? FAKE_WEBM : PNG)
        return {
          path,
          mime: video ? "video/webm" : "image/png",
          dispose: () => rm(dir, { recursive: true, force: true })
        }
      }
    })
  )
)
