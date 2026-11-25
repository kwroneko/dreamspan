// The picture a PNG card export uses for a card that has none (ST puts its default avatar in
// that place): the app's own initials tile at ST's avatar size, 400×600, on a tint picked from
// the name so the same card always gets the same one. Made only for the file; the card is not
// changed. Where the host has no font the tile comes out without the letters, still a valid PNG.
import sharp from "sharp"

const WIDTH = 400
const HEIGHT = 600

// Tint, text: the app's initials tiles (client/src/ui/Avatar.tsx) as solid colors.
const TINTS: ReadonlyArray<readonly [string, string]> = [
  ["#1f2b44", "#7aa2f7"],
  ["#1d3a2a", "#7dd3a0"],
  ["#43361a", "#e6b450"],
  ["#432125", "#f2777a"]
]

/** The same up-to-two initials the app's tiles show. */
const initialsOf = (name: string) =>
  [
    ...name
      .split(/\s+/)
      .filter((word) => word !== "")
      .slice(0, 2)
      .map((word) => [...word][0]!.toUpperCase())
      .join("")
  ]
    .slice(0, 2)
    .join("") || "?"

const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!)

const tintOf = (name: string) => {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return TINTS[Math.abs(hash) % TINTS.length]!
}

export const placeholderPortrait = async (name: string): Promise<Uint8Array> => {
  const [background, color] = tintOf(name)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>` +
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="sans-serif" font-weight="600" ` +
    `font-size="${Math.round(WIDTH * 0.4)}" fill="${color}">${escapeXml(initialsOf(name))}</text></svg>`
  try {
    return await sharp(Buffer.from(svg)).png().toBuffer()
  } catch {
    return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background } })
      .png()
      .toBuffer()
  }
}
