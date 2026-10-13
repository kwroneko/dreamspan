import type { Browser } from "@playwright/test"
import type { FixtureSet } from "./fixtures.ts"
import type { MockEndpoint } from "./mock.ts"
import { gateLore } from "../support/loreFixtures.ts"
import type { Section } from "./report.ts"
import { captureWithSettings } from "./st.ts"

export const checkPreviewOverlap = async (
  browser: Browser,
  url: string,
  mock: MockEndpoint,
  fixtures: FixtureSet
): Promise<Section> => {
  const differences: Array<string> = []
  const notes: Array<string> = []
  for (const mode of ["unprotected", "protected"] as const) {
    const { body } = await captureWithSettings(
      browser,
      url,
      mock,
      {
        character: fixtures.gateCards[0]!,
        presets: ["default"],
        message: "Is the crossing possible?",
        previewOverlap: mode
      },
      undefined,
      undefined,
      {
        text: "KEEP THIS INSTRUCTION",
        position: 1,
        depth: 1,
        role: 0,
        interval: 1
      },
      gateLore.id
    )
    const messages = (body as { messages: Array<{ content: string }> }).messages
    const note = messages.find((m) => m.content.includes("KEEP THIS INSTRUCTION"))?.content ?? ""
    const expected = mode === "protected" ? 1 : 2
    for (const text of ["The lower bank is dark.", "The upper bank has lanterns."]) {
      const count = note.split(text).length - 1
      if (count !== expected)
        differences.push(`${mode}: expected ${expected} copies of ${JSON.stringify(text)}, got ${count}`)
    }
    notes.push(`${mode}: controlled preview/live overlap, ${expected} copies of each lore entry required`)
  }
  return { title: "ST preview overlap regression", notes, differences }
}
