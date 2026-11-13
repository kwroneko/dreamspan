import { PENDING_MEDIA } from "./mediaQueue.ts"
import { savedMedia } from "./savedMedia.ts"

// URLs in message media name this account's saved copy (savedMedia.ts) or the authenticated
// proxy. A scope exists only after consent was read for this message's card/chat. An address
// not looked up yet shows a blank placeholder: it never reaches the other site before the
// lookup says it isn't saved. Relative app paths are never accepted.
export const proxyMediaUrl = (raw: string, scope: string | null | undefined): string | null => {
  const saved = savedMedia.answer(raw)
  if (saved.kind === "saved") return saved.path
  if (saved.kind === "pending") return PENDING_MEDIA
  if (!scope) return null
  const value = raw.trim()
  if (!/^(?:https?:\/\/|\/\/)/i.test(value)) return null
  try {
    const url = new URL(value, "https://media.invalid")
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    // Quotes and brackets are encoded too, so the address is inert inside CSS and srcset.
    const address = encodeURIComponent(url.href).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
    return `/media/external?${scope}&url=${address}`
  } catch {
    return null
  }
}
export interface MediaPermit {
  readonly scope: string | null
  readonly actions: ReadonlyArray<{
    readonly label: string
    readonly about: string
    readonly allow: () => Promise<unknown>
  }>
  readonly pending: boolean
  readonly error: string | null
}
