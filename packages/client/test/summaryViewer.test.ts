import { describe, expect, it } from "vitest"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import type { LcmSummary } from "@rp/shared/lcm.ts"
import { railRows } from "../src/features/chat/CoverageRail.tsx"
import { audienceName, summaryViewers } from "../src/features/chat/SummaryViewer.tsx"

const cast = (more: Partial<Cast>) =>
  ({
    participants: ["mira", "tobin", "wren"],
    playedByMe: ["tobin"],
    cards: [
      { entityId: "mira", name: "Mira" },
      { entityId: "tobin", name: "Tobin" },
      { entityId: "wren", name: "Wren" }
    ],
    ...more
  }) as unknown as Cast

describe("whose summaries the panel shows", () => {
  it("offers the characters only in separate contexts, without the persona or a narrator", () => {
    expect(summaryViewers(cast({}))).toEqual([])
    expect(summaryViewers(cast({ contextPerSpeaker: "shared" }))).toEqual([])
    expect(summaryViewers(cast({ contextPerSpeaker: "separate" })).map((v) => v.name)).toEqual(["Mira", "Wren"])
    expect(
      summaryViewers(cast({ contextPerSpeaker: "separate", roles: { mira: "narrator" } } as never)).map((v) => v.name)
    ).toEqual(["Wren"])
    expect(summaryViewers(null)).toEqual([])
  })
  it("names a summary's character by any of its identities, and none for a shared one", () => {
    expect(audienceName({}, cast({}))).toBeNull()
    expect(audienceName({ audience: ["old-wren", "wren"] }, cast({}))).toBe("Wren")
    expect(audienceName({ audience: ["gone"] }, cast({}))).toBe("One character")
  })
})

describe("the coverage rail with a character's summaries shown", () => {
  const row = (id: string, from: number, to: number, audience?: Array<string>) =>
    ({ id, level: 1, from, to, ...(audience ? { audience } : {}) }) as unknown as LcmSummary
  it("draws the character's own summary, not the shared one over exactly the same messages", () => {
    const first = row("shared-1", 1, 1)
    const shared = row("shared-2-3", 2, 3)
    const own = row("wren-2-3", 2, 3, ["wren"])
    // Wren reads the shared summary of 1 and her own of 2–3.
    expect(railRows([first, shared, own], [first, own]).map((r) => r.id)).toEqual(["shared-1", "wren-2-3"])
    // Without a character's own summaries, every summary in the coverage is drawn.
    expect(railRows([first, shared], [first, shared]).map((r) => r.id)).toEqual(["shared-1", "shared-2-3"])
    // A shared summary in the character's layer stays, even where an own one overlaps it.
    expect(railRows([shared, own], [shared]).map((r) => r.id)).toEqual(["shared-2-3", "wren-2-3"])
  })
})
