// A card's portrait from an image the agent can read (create_card / edit_card `portrait`): the
// files host reads the image at a path read_file reads, checks it, stores it as the card
// editor's Replace picture does (media storage, then the default cutout's thumbnails) and
// hands the stored file to the card's own write, which sets it in one undoable change.
import type { Effect } from "effect"
import type { ToolContext } from "./tools.ts"

/** The stored image the card write records. */
export interface PortraitMedia {
  readonly sha256: string
  readonly mime: string
  readonly byteSize: number
  readonly width: number | null
  readonly height: number | null
  readonly maxAddedBytes: number
}

export interface PortraitSource {
  readonly id: string
  /**
   * Reads the image at `path` (an /attachments/<id> copy or a path in the files), refuses
   * what isn't a PNG, JPEG, GIF or WebP picture the app can decode, stores it, and runs
   * `commit` with it while the file is held from the media sweep. Fails with an Error
   * whose message tells the agent what to fix.
   */
  readonly apply: <A extends { readonly addedBytes: number }, E>(
    ctx: ToolContext,
    path: string,
    commit: (media: PortraitMedia) => Effect.Effect<A, E>
  ) => Effect.Effect<A, E | Error>
}
