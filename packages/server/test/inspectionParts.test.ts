// Where each source's text sits in a sent message (ARCHITECTURE §15, "Parts").
import { assert, it } from "@effect/vitest"
import { locate, partsOf } from "../src/assembler/inspection.ts"

it("finds each piece in order, keeps repeated text apart, and leaves recorded framing alone", () => {
  const content = "<Mira>\nRain.\n</Mira>\n\nRain."
  assert.deepStrictEqual(
    partsOf(content, [
      { source: 0, text: "Rain." },
      { source: 1, text: "Rain." },
      { source: 2, text: "changed by a script" },
      { source: 3, text: "  " },
      { source: 4, text: "<Mira>" },
      { source: 5, text: "</Mira>", frame: true }
    ]),
    [
      { start: 0, end: 6, source: 4 },
      { start: 7, end: 12, source: 0 },
      { start: 13, end: 20, source: 5, frame: true },
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

it("boxes a rewritten piece where its text was, between the pieces found around it", () => {
  // The probe from the audit (inv A1): a transform rewrote the card's text after assembly.
  const content = "Rewritten card text.\nUnchanged note."
  assert.deepStrictEqual(
    locate(content, [
      { source: 0, text: "Original card text." },
      { source: 1, text: "Unchanged note." }
    ]),
    {
      parts: [
        { start: 0, end: 20, source: 0, rewritten: true },
        { start: 21, end: 36, source: 1 }
      ],
      groups: []
    }
  )
})

it("shares one rewritten text among a run of rewritten pieces, and leaves the assembler's own text alone", () => {
  const content = "[Start]\nA, rewritten. B, rewritten.\n[End]"
  assert.deepStrictEqual(
    locate(content, [
      { source: 0, text: "[Start]" },
      { source: 1, text: "A." },
      { source: 2, text: "B." },
      { source: 3, text: "[End]" }
    ]).parts,
    [
      { start: 0, end: 7, source: 0 },
      { start: 8, end: 35, source: 1, rewritten: true, also: [2] },
      { start: 36, end: 41, source: 3 }
    ]
  )
  // Text a rewrite removed takes nothing; blank pieces and wrappers never take the gap.
  assert.deepStrictEqual(
    locate("[Start]\n\n[End]", [
      { source: 0, text: "[Start]" },
      { source: 1, text: "gone" },
      { source: 2, text: "[End]" }
    ]).parts,
    [
      { start: 0, end: 7, source: 0 },
      { start: 9, end: 14, source: 2 }
    ]
  )
})

it("searches a rewritten block's parts inside the text it took", () => {
  const content = "Intro.\n<Mira>\nREWRITTEN.\nKept.\n</Mira>"
  assert.deepStrictEqual(
    locate(content, [
      { source: 0, text: "Intro." },
      {
        source: 1,
        text: "<Mira>\nOriginal.\nKept.\n</Mira>",
        parts: [
          { source: 2, text: "<Mira>\n", frame: true },
          { source: 3, text: "Original." },
          { source: 4, text: "Kept." },
          { source: 5, text: "\n</Mira>", frame: true }
        ]
      }
    ]),
    {
      parts: [
        { start: 0, end: 6, source: 0 },
        { start: 7, end: 14, source: 2, frame: true },
        { start: 14, end: 24, source: 3, rewritten: true },
        { start: 25, end: 30, source: 4 },
        { start: 30, end: 38, source: 5, frame: true }
      ],
      groups: [{ start: 7, end: 38, source: 1, rewritten: true }]
    }
  )
})

it("keeps nested sources when adjacent rewritten blocks cannot be separated", () => {
  const { parts } = locate("Changed A. Changed B.", [
    { source: 0, text: "Block A.", parts: [{ source: 1, text: "A." }] },
    { source: 2, text: "Block B.", parts: [{ source: 3, text: "B." }] }
  ])
  assert.deepStrictEqual(parts, [{ start: 0, end: 21, source: 0, rewritten: true, also: [1, 2, 3] }])
})

it("boxes unlocated rewritten text even when the located neighbours moved out of order", () => {
  const content = "Right. Changed. Left."
  const { parts } = locate(content, [
    { source: 0, text: "Left." },
    { source: 1, text: "Original." },
    { source: 2, text: "Right." }
  ])
  assert.deepStrictEqual(parts, [
    { start: 0, end: 6, source: 2 },
    { start: 7, end: 15, source: 1, rewritten: true },
    { start: 16, end: 21, source: 0 }
  ])
})

// Owner, 2026-11-24: a new chat's first request called an imported card's greeting "rewritten".
// Its recorded piece kept the card's CRLF; the message goes out without carriage returns.
const greeting = '*Mira looks up from the ledger.* "You\'re late, Tobin."\r\n\r\n*She sets down her pen.* "Sit, Tobin."'
const sent = greeting.replace(/\r/g, "")

it("finds a piece whose only difference is the carriage returns the message lost, not rewritten", () => {
  assert.deepStrictEqual(locate(sent, [{ source: 0, text: greeting }]), {
    parts: [{ start: 0, end: sent.length, source: 0 }],
    groups: []
  })
})

it("attributes normalized history before an identical preset prompt with carriage returns", () => {
  const normalized = "The rain.\nThe river."
  const original = normalized.replaceAll("\n", "\r\n")
  const content = `${normalized}\n\n${original}`
  assert.deepStrictEqual(
    partsOf(content, [
      { source: 0, text: original },
      { source: 1, text: original }
    ]),
    [
      { start: 0, end: normalized.length, source: 0 },
      { start: normalized.length + 2, end: content.length, source: 1 }
    ]
  )
})

it("still marks a piece a prompt regex script changed as rewritten, CRLF or not", () => {
  const changed = sent.replace("Sit, Tobin.", "Sit down, Tobin.")
  assert.deepStrictEqual(locate(changed, [{ source: 0, text: greeting }]).parts, [
    { start: 0, end: changed.length, source: 0, rewritten: true }
  ])
})
