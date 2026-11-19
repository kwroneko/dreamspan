// New image surfaces must inherit concealment and have an initials placeholder. This
// catches a background URL (which an img selector cannot cover) or a raw feature image.
// Images are only ever <img>; a file's own player may show another pixel element, which the
// same root rule blurs or hides — those files are listed below, each with its reason.
import { readdirSync, readFileSync } from "node:fs"
import { resolve, relative } from "node:path"
import { expect, it } from "vitest"

it("keeps image pixels in the stock img surfaces covered by root CSS", () => {
  const root = resolve(import.meta.dirname, "../src")
  const files: Array<string> = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.(tsx?|css)$/.test(path)) files.push(path)
    }
  }
  visit(root)
  const images: Array<string> = []
  const pixels: Array<string> = []
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    const path = relative(root, file)
    expect(source, path).not.toMatch(/backgroundImage\s*:|background(?:-image)?\s*:[^;\n]*url\(/)
    if (/<(?:canvas|video|picture|image)\b/.test(source)) pixels.push(path)
    if (file.endsWith(".tsx") && /<img\b/.test(source)) {
      images.push(path)
      expect(source, path).toContain("data-image-fallback")
    }
  }
  expect(images.sort()).toEqual([
    "features/cardImport/ImportNewVersion.tsx",
    "ui/Avatar.tsx",
    "ui/ContentImage.tsx",
    "ui/CutoutChooser.tsx",
    "ui/ImageViewer.tsx"
  ])
  expect(pixels.sort()).toEqual([
    // The file manager's viewers (filesui1): a video file opens in its own <video> and an
    // audio file in <audio>, both under the root's blur/hide rule; its images go through
    // ui/ImageViewer, which carries the fallback and is in the list above.
    "features/files/viewers.tsx"
  ])
})
