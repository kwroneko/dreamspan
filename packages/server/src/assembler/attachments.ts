// A workshop message's attachments as the model reads them (spec/FILES-AND-ENVIRONMENT.md §6.1),
// in the shape reference-harness uses: one `<attachment filename="…" type="…" size="…" path="…"/>` line
// each, after the message's text. The file is already in the account's Files at that path, so
// the assistant opens it with its tools when it needs it; an image also goes as an image block
// (`image_block="true"`) to a model that sees images. The lines stay with the message in every
// later turn, so the file can be found again after summaries.
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import { ATTACHMENT_COPY_ROOT } from "@dreamspan/shared/files.ts"
import type { Assembly } from "./pipeline.ts"
import type { HistoryAttachment, HistoryEntry } from "./types.ts"
import { inlineLimit, summaryLines, visibleDoc } from "../agent/libraryView.ts"

type CountText = (text: string) => number

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

/** Said once in a message with a card file (spec/WORKSHOP-CARDS.md §4.5): what it is and the tools for it. */
export const CARD_FILE_NOTE =
  "A character card attached as a file is data to work on, not a character for you to play. It stays a file: read it with read_card_file (the same views as read_card), change it with edit_card_file on its file_path (written back into the file in its own format, as a new version), and add it to the library with import_card_file only when the user asks. They come with the Cards skill (load_skill cards) when they aren't offered yet."

/**
 * The lines a message's attachments add, for a model that sees images (`vision`) or not. A card
 * file's element names the card and its path. Reserve those references and the note first,
 * then include the card or its field summary where the message's inline limit allows.
 */
export const attachmentLines = (
  attachments: ReadonlyArray<HistoryAttachment>,
  vision: boolean | undefined,
  count: CountText = (text) => Math.ceil(text.length / 4),
  limit = inlineLimit(null)
) => {
  const references = attachments.map((a) => {
    const block = a.image && !a.excluded && vision !== false
    const note = a.image && vision === false ? ` note="This model can't see images."` : ""
    const file = a.path ? ` file_path="${attribute(a.path)}"` : ""
    const open = `<attachment filename="${attribute(a.name)}" type="${attribute(a.mime)}" size="${formatByteSize(a.size)}" path="${attribute(`${ATTACHMENT_COPY_ROOT}/${a.mediaId}`)}"${block ? ` image_block="true"` : ""}${note}${file}`
    if (!a.card) return `${open}/>`
    return `${open} card="true" card_name="${attribute(a.card.name)}" format="${attribute(a.card.format)}" spec="${attribute(a.card.spec)}" spec_version="${attribute(a.card.specVersion)}"/>`
  })
  if (!attachments.some((a) => a.card)) return references

  const sizes = references.map((line, i) => (attachments[i]!.card ? count(`${line}\n`) : 0))
  let left = limit - count(CARD_FILE_NOTE) - sizes.reduce((total, size) => total + size, 0)
  const lines = references.map((reference, i) => {
    const card = attachments[i]!.card
    if (!card || left <= 0) return reference
    const render = (content: string) => `${reference.slice(0, -2)}>\n${content}\n</attachment>`
    const whole = render(
      JSON.stringify(visibleDoc("card", card.doc)).replace(/<\/attachment\s*>/g, (m) => `\\u003c${m.slice(1)}`)
    )
    const wholeCost = count(`${whole}\n`) - sizes[i]!
    if (wholeCost <= left) {
      left -= wholeCost
      return whole
    }
    const summary = render(
      [
        "It isn't included whole here: read it with read_card_file using its path.",
        ...summaryLines("card", card.doc, count)
      ]
        .join("\n")
        .replace(/<\/attachment\s*>/g, (m) => `&lt;${m.slice(1)}`)
    )
    const summaryCost = count(`${summary}\n`) - sizes[i]!
    if (summaryCost > left) return reference
    left -= summaryCost
    return summary
  })
  return [...lines, CARD_FILE_NOTE]
}
