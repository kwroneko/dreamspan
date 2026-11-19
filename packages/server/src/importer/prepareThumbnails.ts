// Card avatars get their thumbnails when they're stored (ARCHITECTURE.md §14.5b), on the
// format workers that parsed them, so a library of hundreds of new cards shows its grid
// from files on disk instead of making each thumbnail while the browser waits.
import { Effect } from "effect"
import type { AvatarCrop } from "@dreamspan/shared/media.ts"
import { mediaPath } from "../db/media.ts"
import type { Formats } from "./Formats.ts"

/**
 * Makes the thumbnails of the avatars among `media`, of the cutout they show (§14.5c: `crop`,
 * null for the default). A failure only leaves them to be made on first view.
 */
export const prepareAvatarThumbnails = (
  formats: Formats["Service"],
  dataDir: string,
  media: ReadonlyArray<{ readonly role: "avatar" | "asset"; readonly sha256: string }>,
  crop: AvatarCrop | null = null
) =>
  Effect.forEach(
    media.filter((file) => file.role === "avatar"),
    (file) => Effect.ignore(formats.prepareThumbnails({ dataDir, path: mediaPath(file.sha256), crop })),
    { discard: true }
  )
