// `crypto.randomUUID` exists only in secure contexts, and a plain-HTTP LAN address isn't one;
// `crypto.getRandomValues` works everywhere. The lint config forbids `crypto.randomUUID` in the client.

/** A random (version 4) UUID, such as "3b241101-e2bb-4255-8caf-4136c566a962". */
export const uuid = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
