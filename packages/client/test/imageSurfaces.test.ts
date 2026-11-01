// New image surfaces must inherit concealment and have an initials placeholder. This
// catches a background URL (which an img selector cannot cover) or a raw feature image.
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
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    expect(source, relative(root, file)).not.toMatch(/backgroundImage\s*:|background(?:-image)?\s*:[^;\n]*url\(/)
    expect(source, relative(root, file)).not.toMatch(/<(?:canvas|video|picture|image)\b/)
    if (file.endsWith(".tsx") && /<img\b/.test(source)) {
      images.push(relative(root, file))
      expect(source).toContain("data-image-fallback")
    }
  }
  expect(images.sort()).toEqual(["ui/Avatar.tsx", "ui/ContentImage.tsx", "ui/ImageViewer.tsx"])
})
