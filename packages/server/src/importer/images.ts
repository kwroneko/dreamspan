// An image's type from its first bytes, never from a name or a header the client sent:
// for files that come with an import (importers.ts) and for avatars (routes.ts).

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The image type, and a PNG's size from its header; `application/octet-stream` for anything else. */
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
  return { mime, width: null, height: null }
}
