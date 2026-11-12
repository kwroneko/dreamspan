import { describe, expect, it } from "vitest"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
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
