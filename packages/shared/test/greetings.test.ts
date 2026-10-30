import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { greetingPick, greetingSources, offeredGreetings } from "../src/greetings.ts"

const card = { greetings: ["First", "Alternate"], groupGreetings: ["Together"] }
describe("pending greetings", () => {
  it("offers ordinary greetings in every cast and group-only greetings only above one character", () => {
    expect(offeredGreetings(card, 1).map((item) => item.text)).toEqual(["First", "Alternate"])
    const group = offeredGreetings(card, 2)
    expect(group.map((item) => item.text)).toEqual(["First", "Alternate", "Together"])
    expect(group[2]).toEqual({ text: "Together", index: 2, groupOnly: true })
    expect(greetingPick(offeredGreetings(card, 1), 2)?.text).toBe("First")
    expect(greetingPick(offeredGreetings(card, 2), 1)?.text).toBe("Alternate")
    expect(offeredGreetings({ greetings: [], groupGreetings: ["Only group"] }, 1)).toEqual([])
  })
  it("allows a plugin to disable and restore the group source", () => {
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          yield* greetingSources.disable("greetings.group-only")
          expect(offeredGreetings(card, 2).map((item) => item.text)).toEqual(card.greetings)
        })
      )
    )
    expect(offeredGreetings(card, 2)).toHaveLength(3)
  })
})
