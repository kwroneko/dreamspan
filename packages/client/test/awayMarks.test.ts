import { describe, expect, it } from "vitest"
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import type { ChatSession } from "../src/features/chat/session.ts"
import type { AwayMark } from "@rp/shared/contextsApi.ts"
import { awayExplanation, awayLabel, awayTransitions, awayRowsOf } from "../src/features/chat/awayMarks.ts"

const wren = "wren" as EntityId
const mira = "mira" as EntityId
const names: Record<string, string> = { wren: "Wren", mira: "Mira" }
const name = (id: EntityId) => names[id] ?? "Someone"
const mark = (eventId: string, slot: string, entityId: EntityId, away: boolean, by: AwayMark["by"], setBy?: EntityId) =>
  ({ eventId, slotId: slot as SlotId, entityId, away, by, ...(setBy ? { setBy } : {}) }) as AwayMark

describe("the timeline's away rows", () => {
  it("shows only the changes: a repeated mark is no row", () => {
    const rows = awayTransitions([
      mark("e1", "s1", wren, true, "decision"),
      mark("e2", "s2", wren, true, "user"),
      mark("e3", "s3", wren, false, "user"),
      mark("e4", "s4", wren, false, "decision")
    ])
    expect(rows.map((row) => [row.eventId, row.away])).toEqual([
      ["e1", true],
      ["e3", false]
    ])
  })
  it("offers Undo only on the scene check's departure", () => {
    const rows = awayTransitions([
      mark("e1", "s1", wren, true, "decision"),
      mark("e2", "s2", wren, false, "decision"),
      mark("e3", "s3", mira, true, "user")
    ])
    expect(rows.map((row) => row.undoable)).toEqual([true, false, false])
  })
  it("shows nothing for a narrator", () => {
    expect(awayTransitions([mark("e1", "s1", mira, true, "user")], new Set([mira]))).toEqual([])
  })
  it("names who set it", () => {
    const [left, back, own, other] = awayTransitions([
      mark("e1", "s1", wren, true, "decision"),
      mark("e2", "s2", wren, false, "user"),
      mark("e3", "s3", wren, true, "character", wren),
      mark("e4", "s4", mira, true, "character", wren)
    ])
    expect(awayLabel(left!, name)).toBe("Wren left · scene check")
    expect(awayLabel(back!, name)).toBe("Wren is back · you")
    expect(awayLabel(own!, name)).toBe("Wren left · own reply")
    expect(awayLabel(other!, name)).toBe("Mira left · Wren's reply")
    expect(awayExplanation(left!, name)).toContain("A decision model judged that Wren left")
    expect(awayExplanation(other!, name)).toContain("Wren's reply marked Mira away")
  })
})

it("reads away marks again after its last timeline listener was absent", async () => {
  let marks: ReadonlyArray<AwayMark> = []
  let reads = 0
  const session = {
    id: "chat",
    snapshot: () => ({ forkId: "fork", leafSlotId: "s1", loading: false, cast: { roles: {} } }),
    subscribe: () => () => {},
    subscribePositions: () => () => {},
    call: async () => {
      reads++
      return { ok: true, value: marks }
    }
  } as unknown as ChatSession
  const store = awayRowsOf(session)
  const stop = store.subscribe(() => {})
  await Promise.resolve()
  expect(store.at("s1" as SlotId)).toHaveLength(0)
  stop()
  marks = [mark("new-away", "s1", wren, true, "decision")]
  const stopAgain = store.subscribe(() => {})
  await Promise.resolve()
  expect(reads).toBe(2)
  expect(store.at("s1" as SlotId).map((row) => row.eventId)).toEqual(["new-away"])
  stopAgain()
})
