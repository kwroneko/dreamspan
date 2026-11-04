// UI text doesn't explain things relative to SillyTavern (DESIGN §10.1, owner 2026-11-02): this is
// an independent product, and users needn't come from ST. ST is named only where the text is
// about interop itself: importing from it, exporting to it, its file formats, an import report.
// Every string literal, template and JSX text in the client is checked; comments aren't.
import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

/** Files that are interop surfaces through and through: the ST import and its reports. */
const INTEROP_FILES = new Set([
  "features/library/stImport.tsx",
  "features/library/stJobs.tsx",
  "features/library/import.tsx",
  "features/library/FolderBrowser.tsx",
  "features/connections/StSettingsImport.tsx",
  "features/connections/list.tsx",
  "features/chat/chatExport.tsx"
])

/** Single interop strings elsewhere: an import or export entry point. */
const INTEROP_STRINGS = new Set([
  "features/chat/headerContributions.tsx\tDownloads the branch shown as a SillyTavern chat file or plain text.",
  "features/characters/CharactersPage.tsx\tImport from SillyTavern",
  "features/characters/CharactersPage.tsx\tOpens the SillyTavern importer.",
  "features/firstRun/FirstRunSteps.tsx\tImport from SillyTavern"
])

const NAMES_ST = /SillyTavern|\bST\b/

const texts = (file: string): Array<string> => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: Array<string> = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text)
    else if (ts.isJsxText(node)) found.push(node.text.replace(/\s+/g, " ").trim())
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

it("names SillyTavern in UI text only where the text is about interop", () => {
  const root = resolve(import.meta.dirname, "../src")
  const files: Array<string> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path)
    }
  }
  walk(root)
  const offending: Array<string> = []
  for (const file of files) {
    const name = relative(root, file)
    if (INTEROP_FILES.has(name)) continue
    for (const text of texts(file)) {
      if (NAMES_ST.test(text) && !INTEROP_STRINGS.has(`${name}\t${text}`)) offending.push(`${name}: ${text}`)
    }
  }
  expect(offending).toEqual([])
})
