// The starting persona of a new chat (DESIGN §2.2): a live lock for the character, else the
// account default; groups never use a lock. Synthetic ids only.
import { describe, expect, it } from "vitest"
import { startingPersona, type StartingPersona } from "../src/personaLock.ts"

const live =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id)

const start = (choice: Omit<StartingPersona<string>, "characters">) =>
  startingPersona({ characters: ["harbor"], ...choice })

describe("startingPersona", () => {
  it("starts a single chat with the persona locked to its character", () => {
    expect(start({ single: true, lock: "pilot", defaultPersona: "mapmaker", live: live("pilot", "mapmaker") })).toBe(
      "pilot"
    )
  })
  it("uses the account default without a lock, or none without either", () => {
    expect(start({ single: true, lock: null, defaultPersona: "mapmaker", live: live("mapmaker") })).toBe("mapmaker")
    expect(start({ single: true, lock: null, defaultPersona: null, live: live() })).toBeNull()
  })
  it("falls back to the default when the locked persona is binned, archived or no longer a persona", () => {
    expect(start({ single: true, lock: "pilot", defaultPersona: "mapmaker", live: live("mapmaker") })).toBe("mapmaker")
    expect(start({ single: true, lock: "pilot", defaultPersona: null, live: live() })).toBeNull()
    expect(start({ single: true, lock: "pilot", defaultPersona: "mapmaker", live: live() })).toBeNull()
  })
  it("never applies a lock to a group chat", () => {
    expect(start({ single: false, lock: "pilot", defaultPersona: "mapmaker", live: live("pilot", "mapmaker") })).toBe(
      "mapmaker"
    )
    expect(start({ single: false, lock: "pilot", defaultPersona: null, live: live("pilot") })).toBeNull()
  })
})
