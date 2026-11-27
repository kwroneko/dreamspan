// New image surfaces must inherit concealment and have an initials placeholder. This
// catches unregistered background URLs and raw feature images.
// A file's own player may show another pixel element, which the
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
    if (path === "features/chat/ChatBackdrop.tsx") {
      // Tiling the wallpaper needs CSS. Its pixel layer has its own root concealment selector.
      expect(source).toContain("data-wallpaper-pixels")
      const css = readFileSync(resolve(root, "styles.css"), "utf8")
      for (const mode of ["blur", "hide"])
        expect(css).toMatch(new RegExp(`data-images="${mode}"[^\\n]*data-wallpaper-pixels`))
    } else expect(source, path).not.toMatch(/backgroundImage\s*:|background(?:-image)?\s*:[^;\n]*url\(/)
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
    // The PDF viewer (files4b) draws each page, embedded pictures included, on a <canvas>;
    // the root's canvas rule blurs or hides pages and thumbnails like any other image.
    "features/files/PdfViewer.tsx",
    // The file manager's viewers (filesui1): a video file opens in its own <video> and an
    // audio file in <audio>, both under the root's blur/hide rule; its images go through
    // ui/ImageViewer, which carries the fallback and is in the list above.
    "features/files/viewers.tsx"
  ])
})
