// The thinking panels' "Sent to the model" indicator reads the next request's own decision
// (`NextContext.thinking`): every reason it gives maps to one state, never worked out anew.
import type { Version, VersionId } from "@dreamspan/shared/chat.ts"
import type { ThinkingSendReason, ThinkingSends } from "@dreamspan/shared/thinkingSends.ts"
import { describe, expect, it } from "vitest"
import { thinkingStatus } from "../src/features/chat/thinkingStatus.ts"

const id = "v-1" as VersionId
const version = { id } as Version
const sends = (reason: ThinkingSendReason, part: "reasoning" | "sections" = "reasoning"): ThinkingSends => ({
  sections: 2,
  reasoning: 2,
  items: [{ versionId: id, part, sent: reason === "sent", reason }]
})
const of = (input: Partial<Parameters<typeof thinkingStatus>[0]>) =>
  thinkingStatus({ version, kind: "reasoning", hidden: false, streaming: false, sends: undefined, ...input })

describe("thinking status", () => {
  it("says sent exactly when the request sends it, and a click flips it", () => {
    for (const kind of ["reasoning", "sections"] as const) {
      const sent = of({ kind, sends: sends("sent", kind) })
      expect(sent).toMatchObject({ sent: true, toggles: true })
      expect(sent.hint).toMatch(/^Sent with the next replies: it's within the last 2 replies the preset sends back\./)
      expect(sent.hint).toContain("for this thinking only")
    }
  })

  it("for each reason the settings keep it out: not sent, says why, and isn't clickable", () => {
    for (const reason of ["changed", "model", "provider", "ignored", "unrecorded", "merged"] as const) {
      const status = of({ sends: sends(reason) })
      expect(status.sent).toBe(false)
      expect(status.toggles).toBe(false)
      expect(status.hint).toMatch(/^Not sent: .+\.$/)
      expect(status.hint).not.toContain("Click")
    }
  })

  it("left out by the user: not sent, and a click sends it again where the preset allows", () => {
    for (const status of [
      of({ hidden: true }),
      of({ sends: sends("hidden") }),
      of({ hidden: true, sends: sends("sent") })
    ])
      expect(status).toMatchObject({ sent: false, toggles: true })
    expect(of({ hidden: true }).hint).toContain("you left it out")
  })

  it("with nothing sent back, says the preset sends none", () => {
    expect(of({}).hint).toBe("Not sent: the preset sends no provider reasoning back.")
    expect(of({ kind: "sections" }).hint).toBe("Not sent: the preset sends no tagged thinking back.")
    expect(of({}).toggles).toBe(false)
  })

  it("outside the last N: says how many the preset sends", () => {
    const one: ThinkingSends = { sections: 1, reasoning: 1, items: [] }
    expect(of({ sends: one }).hint).toBe("Not sent: the preset sends back only the last reply's reasoning.")
    expect(of({ kind: "sections", sends: { ...one, sections: 3 } }).hint).toBe(
      "Not sent: the preset sends back only the last 3 replies' thinking."
    )
  })

  it("a tool run's reply while it's written: sent for the run unless left out, and always clickable", () => {
    const agent = { id, agent: true } as unknown as Version
    expect(of({ version: agent, streaming: true })).toMatchObject({ sent: true, toggles: true })
    expect(of({ version: agent, streaming: true, hidden: true })).toMatchObject({ sent: false, toggles: true })
    // A plain reply while it's written: not known yet.
    expect(of({ streaming: true, sends: { sections: 1, reasoning: 1, items: [] } })).toMatchObject({
      sent: false,
      toggles: false
    })
  })
})
