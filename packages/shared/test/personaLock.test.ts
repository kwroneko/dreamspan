// The starting persona of a new chat (DESIGN §2.2): a live lock for the character, else the
// account default; groups never use a lock. Synthetic ids only.
import { describe, expect, it } from "vitest"
import { startingPersona } from "../src/personaLock.ts"

const live =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id)

describe("startingPersona", () => {
  it("starts a single chat with the persona locked to its character", () => {
    expect(
      startingPersona({ single: true, lock: "pilot", defaultPersona: "mapmaker", live: live("pilot", "mapmaker") })
    ).toBe("pilot")
  })
  it("uses the account default without a lock, or none without either", () => {
    expect(startingPersona({ single: true, lock: null, defaultPersona: "mapmaker", live: live("mapmaker") })).toBe(
      "mapmaker"
    )
    expect(startingPersona({ single: true, lock: null, defaultPersona: null, live: live() })).toBeNull()
  })
  it("falls back to the default when the locked persona is binned, archived or no longer a persona", () => {
    expect(startingPersona({ single: true, lock: "pilot", defaultPersona: "mapmaker", live: live("mapmaker") })).toBe(
      "mapmaker"
    )
    expect(startingPersona({ single: true, lock: "pilot", defaultPersona: null, live: live() })).toBeNull()
    expect(startingPersona({ single: true, lock: "pilot", defaultPersona: "mapmaker", live: live() })).toBeNull()
  })
  it("never applies a lock to a group chat", () => {
    expect(
      startingPersona({ single: false, lock: "pilot", defaultPersona: "mapmaker", live: live("pilot", "mapmaker") })
    ).toBe("mapmaker")
    expect(startingPersona({ single: false, lock: "pilot", defaultPersona: null, live: live("pilot") })).toBeNull()
  })
})
