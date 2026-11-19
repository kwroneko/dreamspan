// A workshop message's attachments as the model reads them (spec/FILES-AND-ENVIRONMENT.md §6.1),
// in the shape reference-harness uses: one `<attachment filename="…" type="…" size="…" path="…"/>` line
// each, after the message's text. The file is already in the account's Files at that path, so
// the assistant opens it with its tools when it needs it; an image also goes as an image block
// (`image_block="true"`) to a model that sees images. The lines stay with the message in every
// later turn, so the file can be found again after summaries.
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import type { Assembly } from "./pipeline.ts"
import type { HistoryAttachment, HistoryEntry } from "./types.ts"

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/**
 * Whether a workshop request leaves an image saved in Files out as a block: its model can't see
 * images, and it gets the path instead (no caption: that would send the image to a model the
 * user didn't choose for it).
 */
export const pathOnlyImage = (assembly: Assembly, entry: HistoryEntry, mediaId: string) =>
  assembly.request.agent?.workshop === true &&
  assembly.model?.vision === false &&
  (entry.attachments ?? []).some((a) => a.image && a.mediaId === mediaId)

/** The lines a message's attachments add, for a model that sees images (`vision`) or not. */
export const attachmentLines = (attachments: ReadonlyArray<HistoryAttachment>, vision: boolean | undefined) =>
  attachments.map((a) => {
    const block = a.image && !a.excluded && vision !== false
    const note = a.image && vision === false ? ` note="This model can't see images."` : ""
    return `<attachment filename="${attribute(a.name)}" type="${attribute(a.mime)}" size="${formatByteSize(a.size)}" path="${attribute(a.path)}"${block ? ` image_block="true"` : ""}${note}/>`
  })
