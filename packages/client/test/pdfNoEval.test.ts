// The PDF viewer runs nothing a document brings (spec/FILES-AND-ENVIRONMENT.md §8): pdf.js builds
// font programs with `new Function` only where it has an `isEvalSupported` option, and the viewer
// loads documents with scripts, XFA, worker fetches and system fonts off. If an upgrade brings the
// option back, this fails until the viewer sets it to false.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { expect, it } from "vitest"

const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))

it("pdf.js has no eval path, or the viewer turns it off", () => {
  const viewer = readFileSync(join(import.meta.dirname, "../src/features/files/PdfViewer.tsx"), "utf8")
  for (const file of ["build/pdf.mjs", "build/pdf.worker.mjs"]) {
    const source = readFileSync(join(root, file), "utf8")
    const evals = /\bnew Function\(|\beval\(/.test(source) || source.includes("isEvalSupported")
    if (evals) expect(viewer).toMatch(/isEvalSupported:\s*false/)
  }
  for (const option of ["enableXfa", "useWorkerFetch", "useSystemFonts"])
    expect(viewer).toMatch(new RegExp(`${option}:\\s*false`))
})
