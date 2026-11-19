// The version picker's text filter and sort (VersionPicker.tsx `arrange`): any case, every
// sort with ties in the order written, and quick with fifty long versions.
import { expect, test } from "vitest"
import { Version, type SlotId, type VersionId } from "@dreamspan/shared/chat.ts"
import { arrange, plain } from "../src/features/chat/VersionPicker.tsx"

const version = (n: number, content: string, fields: { starred?: boolean; createdAt?: number } = {}) =>
  new Version({
    id: `v${n}` as VersionId,
    slotId: "s" as SlotId,
    ordinal: n,
    status: "complete",
    speakerEntityId: null,
    writer: "model",
    content,
    macroMode: "verbatim",
    origin: "generated",
    sourceVersionId: null,
    direction: null,
    hidden: false,
    starred: fields.starred ?? false,
    createdAt: fields.createdAt ?? n,
    model: null,
    error: null,
    mark: null,
    frozenMacros: null,
    context: null,
    rowVersion: 0
  })

const versions = [
  version(1, "The lighthouse keeper waves."),
  version(2, "A gull lands.", { starred: true }),
  version(3, "Fog rolls over the LIGHTHOUSE at dusk, slowly.", { createdAt: 0 }),
  version(4, "Rain.", { starred: true })
]
const ids = (list: ReadonlyArray<Version>) => list.map((v) => v.id)

test("finds versions by their text in any case, keeping the order written", () => {
  expect(ids(arrange(versions, "  Lighthouse ", "written"))).toEqual(["v1", "v3"])
  expect(ids(arrange(versions, "zeppelin", "written"))).toEqual([])
  expect(ids(arrange(versions, "", "written"))).toEqual(["v1", "v2", "v3", "v4"])
})

test("sorts newest, longest, shortest and starred first, ties in the order written", () => {
  expect(ids(arrange(versions, "", "newest"))).toEqual(["v4", "v2", "v1", "v3"])
  expect(ids(arrange(versions, "", "longest"))).toEqual(["v3", "v1", "v2", "v4"])
  expect(ids(arrange(versions, "", "shortest"))).toEqual(["v4", "v2", "v1", "v3"])
  expect(ids(arrange(versions, "", "starred"))).toEqual(["v2", "v4", "v1", "v3"])
  expect(ids(arrange(versions, "lighthouse", "longest"))).toEqual(["v3", "v1"])
})

test("filters fifty versions of 20,000 characters well within a keystroke", () => {
  const long = Array.from({ length: 50 }, (_, i) =>
    version(i + 1, `${"The tide turns and the waves keep coming. ".repeat(480)}${i === 37 ? "a zeppelin" : ""}`)
  )
  const started = performance.now()
  for (let i = 0; i < 10; i++) expect(ids(arrange(long, "Zeppelin", "longest"))).toEqual(["v38"])
  // Ten filters of a megabyte of text: about a millisecond each on a quiet machine.
  expect(performance.now() - started).toBeLessThan(500)
})

test("newest keeps written order when timestamps tie", () => {
  expect(ids(arrange([version(1, "a", { createdAt: 1 }), version(2, "b", { createdAt: 1 })], "", "newest"))).toEqual([
    "v1",
    "v2"
  ])
})

test("malformed Markdown in fifty long swipes does not stall previewing", () => {
  for (const text of ["[".repeat(20000), " ".repeat(20000), "[link](".repeat(3000)]) {
    const start = performance.now()
    for (let i = 0; i < 50; i++) plain(text)
    expect(performance.now() - start).toBeLessThan(500)
  }
  expect(plain("**Harbour** [keeper](https://example.invalid)\n--- | ---\nMira")).toBe("Harbour keeper Mira")
}, 60000)
