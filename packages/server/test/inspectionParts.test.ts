// Where each source's text sits in a sent message (ARCHITECTURE §15, "Parts").
import { assert, it } from "@effect/vitest"
import { locate, partsOf } from "../src/assembler/inspection.ts"

it("finds each piece in order, keeps repeated text apart, and skips text that isn't there", () => {
  const content = "<Mira>\nRain.\n</Mira>\n\nRain."
  assert.deepStrictEqual(
    partsOf(content, [
      { source: 0, text: "Rain." },
      { source: 1, text: "Rain." },
      { source: 2, text: "changed by a script" },
      { source: 3, text: "  " },
      { source: 4, text: "<Mira>" }
    ]),
    [
      { start: 0, end: 6, source: 4 },
      { start: 7, end: 12, source: 0 },
      { start: 22, end: 27, source: 1 }
    ]
  )
})

it("never overlaps a part already found", () => {
  assert.deepStrictEqual(
    partsOf("abc", [
      { source: 0, text: "abc" },
      { source: 1, text: "b" }
    ]),
    [{ start: 0, end: 3, source: 0 }]
  )
})

it("finds a block's parts only inside the block, and keeps blocks around their parts", () => {
  // "Rain." is first said outside Mira's block; her field is the one inside it.
  const content = "Rain.\n<Mira>\nRain.\n</Mira>"
  assert.deepStrictEqual(
    locate(content, [
      { source: 0, text: "Rain." },
      {
        source: 1,
        text: "<Mira>\nRain.\n</Mira>",
        parts: [
          { source: 2, text: "<Mira>\n", frame: true },
          { source: 3, text: "Rain." },
          { source: 4, text: "\n</Mira>", frame: true }
        ]
      }
    ]),
    {
      parts: [
        { start: 0, end: 5, source: 0 },
        { start: 6, end: 13, source: 2, frame: true },
        { start: 13, end: 18, source: 3 },
        { start: 18, end: 26, source: 4, frame: true }
      ],
      groups: [{ start: 6, end: 26, source: 1 }]
    }
  )
})
