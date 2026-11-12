// URLs in message media always name the authenticated proxy. A scope exists only after
// consent was read for this message's card/chat. Relative app paths are never accepted.
export const proxyMediaUrl = (raw: string, scope: string | null | undefined): string | null => {
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
