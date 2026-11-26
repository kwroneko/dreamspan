// A message's attached image in the image column (owner, 2026-11-07: "Can you open images
// attached to messages in the image viewer?"): a picture like a portrait, under an id that names
// its media and its name, so the view's URL (`portraits`) brings it back after a reload with no
// lookup, and its tab URL (`pictureHref`) is the same as a portrait's.
import type { Portrait } from "../../ui/Portrait.tsx"

const PREFIX = "image:"

/** Names the upload gives an image without a file name of its own. */
const UNNAMED = new Set(["", "Pasted image", "Restored image"])

/**
 * What the viewer and its tab call an attached image: its file name, or "Image from <speaker>"
 * ("Image 2 from Mira" when the message has several; "Image 2" with no speaker to name).
 */
export const attachmentName = (altText: string | undefined, speaker: string | null, index: number, count: number) => {
  const own = altText?.trim() ?? ""
  if (!UNNAMED.has(own)) return own
  return `Image${count > 1 ? ` ${index + 1}` : ""}${speaker === null ? "" : ` from ${speaker}`}`
}

export const attachmentPicture = (mediaId: string, name: string): Portrait => {
  const caption = name.toWellFormed()
  return { id: `${PREFIX}${mediaId}:${encodeURIComponent(caption)}`, name: caption, mediaId, image: true }
}

/** The attached image an id names, or null for any other picture's id. */
export const attachmentOf = (id: string): Portrait | null => {
  const found = /^image:([^:]+):(.*)$/.exec(id)
  if (!found) return null
  try {
    return { id, mediaId: found[1]!, name: decodeURIComponent(found[2]!) || "Image", image: true }
  } catch {
    return null
  }
}
