// An image's type from its first bytes, never from a name or a header the client sent:
// for files that come with an import (importers.ts) and for avatars (routes.ts).

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The image type and its size from its header; `application/octet-stream` for anything else. */
export const describeImage = (bytes: Uint8Array) => {
  const starts = (prefix: ReadonlyArray<number>, offset = 0) =>
    prefix.every((byte, index) => bytes[offset + index] === byte)
  const ascii = (offset: number, text: string) =>
    Buffer.from(bytes.subarray(offset, offset + text.length)).toString("latin1") === text
  if (starts(PNG_SIGNATURE) && ascii(12, "IHDR") && bytes.byteLength >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) }
  }
  const mime = starts([0xff, 0xd8, 0xff])
    ? "image/jpeg"
    : ascii(0, "GIF8")
      ? "image/gif"
      : ascii(0, "RIFF") && ascii(8, "WEBP")
        ? "image/webp"
        : ascii(4, "ftypavif")
          ? "image/avif"
          : ascii(0, "BM")
            ? "image/bmp"
            : "application/octet-stream"
  // The size from the header, which image token estimates need (ARCHITECTURE §15).
  const size = (() => {
    try {
      return sizeOf(mime, bytes, ascii)
    } catch {
      return null
    }
  })()
  return size && size.width > 0 && size.height > 0
    ? { mime, width: size.width, height: size.height }
    : { mime, width: null, height: null }
}

const sizeOf = (
  mime: string,
  bytes: Uint8Array,
  ascii: (offset: number, text: string) => boolean
): { width: number; height: number } | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (mime) {
    case "image/jpeg": {
      // The first start-of-frame segment; C4, C8 and CC are other markers in that range.
      let at = 2
      while (at + 9 < bytes.byteLength) {
        if (bytes[at] !== 0xff) return null
        const marker = bytes[at + 1]!
        if (marker === 0xff) {
          at++
          continue
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
        at += 2 + view.getUint16(at + 2)
      }
      return null
    }
    case "image/gif":
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
    case "image/webp":
      if (ascii(12, "VP8 "))
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
      if (ascii(12, "VP8L")) {
        const bits = view.getUint32(21, true)
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
      }
      if (ascii(12, "VP8X"))
        return {
          width: 1 + (view.getUint16(24, true) | (bytes[26]! << 16)),
          height: 1 + (view.getUint16(27, true) | (bytes[29]! << 16))
        }
      return null
    case "image/bmp":
      return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) }
    case "image/avif": {
      // The image spatial extents property: size, 'ispe', version and flags, width, height.
      const limit = Math.min(bytes.byteLength - 16, 1 << 16)
      for (let at = 0; at < limit; at++)
        if (ascii(at, "ispe")) return { width: view.getUint32(at + 8), height: view.getUint32(at + 12) }
      return null
    }
    default:
      return null
  }
}
