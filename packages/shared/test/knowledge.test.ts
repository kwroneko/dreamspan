import { describe, expect, it } from "vitest"
import type { EntityId } from "../src/chat.ts"
import {
  ABSENT_GAP_DEFAULT,
  ABSENT_JOIN_DEFAULT,
  knowersOf,
  knows,
  parsePresence,
  presenceOf
} from "../src/knowledge.ts"
import { foldState } from "../src/state.ts"

const mira = "mira" as EntityId
const tobin = "tobin" as EntityId
const wren = "wren" as EntityId
const narrator = "narrator" as EntityId

describe("presenceOf", () => {
  it("records nothing while nobody is away and no one narrates", () => {
    const state = foldState([{ scope: null, data: { key: "presence.set", value: { entity: wren, present: false } } }])
    // Mute isn't presence: a muted character is still there.
    expect(presenceOf(state, [mira, tobin, wren])).toBeNull()
  })

  it("records the cast's away members and narrators in cast order; a narrator is never away", () => {
    const state = foldState([
      { scope: null, data: { key: "away.set", value: { entity: wren, away: true } } },
      { scope: null, data: { key: "away.set", value: { entity: narrator, away: true } } },
      { scope: null, data: { key: "cast.role", value: { entity: narrator, role: "narrator" } } },
      // Not in this version's cast: not recorded.
      { scope: null, data: { key: "away.set", value: { entity: "gone" as EntityId, away: true } } }
    ])
    expect(presenceOf(state, [narrator, mira, wren])).toEqual({ away: [wren], narrators: [narrator] })
    expect(presenceOf(state, [mira, tobin])).toBeNull()
  })
})

describe("knowersOf", () => {
  it("is the cast and speaker less those away; the speaker always knows its own message", () => {
    const record = { cast: [mira, tobin, wren], speaker: wren, presence: { away: [wren, tobin] } }
    expect([...knowersOf(record)!].toSorted()).toEqual([mira, wren])
    expect(knows(tobin, record)).toBe(false)
    expect(knows(narrator, record)).toBe(false)
  })

  it("counts a version with no recorded cast as known to everyone", () => {
    expect(knowersOf({ cast: null, speaker: null, presence: null })).toBeNull()
    expect(knows(wren, { cast: null, speaker: null, presence: null })).toBe(true)
  })

  it("reads stored records, and anything malformed as nobody away", () => {
    expect(parsePresence(null)).toBeNull()
    expect(parsePresence('{"away":["wren"]}')).toEqual({ away: ["wren"] })
    expect(parsePresence('{"away":"wren"}')).toBeNull()
    expect(parsePresence("not json")).toBeNull()
  })
})

describe("gap-line defaults", () => {
  it("are the confirmed wording (§2.2 [D]) and an empty join line, which sends nothing", () => {
    expect(ABSENT_GAP_DEFAULT).toBe(
      "[{{char}} wasn't present for {{absentCount}} messages here, in which {{absentNames}} took part.]"
    )
    expect(ABSENT_JOIN_DEFAULT).toBe("")
  })
})
