import { newCardDoc } from "@dreamspan/shared/editing.ts"
import { expect, it } from "vitest"
import { attachmentLines, CARD_FILE_NOTE } from "../src/assembler/attachments.ts"
import type { HistoryAttachment } from "../src/assembler/types.ts"

it("keeps card file summaries within the message budget and preserves each reference", () => {
  const attachments: ReadonlyArray<HistoryAttachment> = Array.from({ length: 12 }, (_, i) => ({
    mediaId: `file-${i}`,
    name: `card-${i}.json`,
    path: `/files/card-${i}.json`,
    mime: "application/json",
    size: 10_000,
    image: false,
    excluded: false,
    card: {
      name: `Card ${i}`,
      format: "json",
      spec: "chara_card_v3",
      specVersion: "3.0",
      doc: { ...newCardDoc(`Card ${i}`), description: "A long description. ".repeat(500) }
    }
  }))
  const limit = 1000
  const lines = attachmentLines(attachments, false, undefined, limit)
  expect(lines.some((line) => line.includes("description:"))).toBe(true)
  expect(lines.some((line) => line.endsWith("/>"))).toBe(true)
  expect(Math.ceil(lines.join("\n").length / 4)).toBeLessThanOrEqual(limit)
  for (const [i, file] of attachments.entries()) {
    expect(lines[i]).toContain(`path="/attachments/${file.mediaId}"`)
    expect(lines[i]).toContain(`card_name="${file.card!.name}"`)
  }
  expect(lines.at(-1)).toBe(CARD_FILE_NOTE)
})
