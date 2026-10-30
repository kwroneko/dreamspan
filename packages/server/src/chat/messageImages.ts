import { Effect } from "effect"
import type { AssembledRequest, ModelInput, RequestImage } from "../assembler/types.ts"
import { DEFAULT_MAX_IMAGES, newestImages } from "../assembler/images.ts"
import { readMedia } from "../importer/mediaFiles.ts"
import { GenerationFailed } from "./Generator.ts"

/** Resolve only the newest admitted images, using the acting owner's media read. */
export const hydrateMessageImages = (
  request: AssembledRequest,
  model: ModelInput,
  lookup: (id: string) => Effect.Effect<{ path: string; mime: string }, unknown>,
  dataDir: string
) =>
  Effect.gen(function* () {
    const count = request.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0)
    if (!count) return request
    if (model.vision === false)
      return yield* new GenerationFailed({
        class: "images_unsupported",
        message: "This model cannot see images. Choose a vision model before replying."
      })
    const newest = newestImages(request.messages, model.maxImages ?? DEFAULT_MAX_IMAGES)
    const cache = new Map<string, RequestImage>()
    const messages = []
    for (const [m, message] of request.messages.entries()) {
      const images = []
      for (const [i, image] of (message.images ?? []).entries()) {
        if (!newest.has(`${m}:${i}`)) {
          // Keep the reference for consistent role/source projection, without its bytes.
          images.push({ mediaId: image.mediaId })
          continue
        }
        let hydrated = cache.get(image.mediaId)
        if (!hydrated) {
          const file = yield* lookup(image.mediaId).pipe(
            Effect.mapError(
              () =>
                new GenerationFailed({
                  class: "image_unavailable",
                  message: "An attached image is no longer available."
                })
            )
          )
          const bytes = yield* readMedia(dataDir, file.path)
          if (!bytes)
            return yield* new GenerationFailed({
              class: "image_unavailable",
              message: "An attached image could not be read."
            })
          hydrated = { mediaId: image.mediaId, mimeType: file.mime, data: bytes.toString("base64") }
          cache.set(image.mediaId, hydrated)
        }
        images.push(hydrated)
      }
      messages.push({ ...message, images })
    }
    return { ...request, messages }
  })
