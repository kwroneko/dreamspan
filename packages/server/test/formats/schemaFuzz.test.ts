// Every field of the fixtures replaced in turn by values that are wrong in some way. Each
// import must either succeed with a document its schema accepts, or fail with FormatError;
// never with a defect.
import { CardDoc } from "@rp/shared/docs/card.ts"
import { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { importCard } from "../../src/formats/cardImport.ts"
import type { FormatError } from "../../src/formats/safety.ts"
import { importLorebook } from "../../src/formats/worldInfo.ts"
import { cardV3, json, stCardV2, worldInfo } from "./support.ts"

const HOSTILE: ReadonlyArray<unknown> = [
  1e300,
  -1,
  1.5,
  2 ** 53,
  -(2 ** 53),
  "100000000000000000000000",
  "x",
  "",
  null,
  true,
  {},
  [],
  [1e300],
  ["x", 1],
  { toString: 0 },
  { valueOf: 0, toString: 0 }
]

/** Every path to a field in `value`, objects and list items included. */
const paths = (value: unknown, prefix: ReadonlyArray<string | number> = []): Array<Array<string | number>> => {
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...prefix, Array.isArray(value) ? Number(key) : key]
    return [path, ...paths(child, path)]
  })
}

const replaced = (value: unknown, path: ReadonlyArray<string | number>, replacement: unknown): unknown => {
  if (path.length === 0) return replacement
  const copy = (Array.isArray(value) ? [...value] : { ...(value as object) }) as Record<string | number, unknown>
  copy[path[0]!] = replaced(copy[path[0]!], path.slice(1), replacement)
  return copy
}

const check = <A>(effect: Effect.Effect<A, FormatError>, decode: (value: A) => unknown, label: string) => {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isSuccess(exit)) expect(() => decode(exit.value), label).not.toThrow()
  else expect(Cause.hasDies(exit.cause), label).toBe(false)
}

describe("importers under hostile field values", () => {
  it("always produce a card the schema accepts", () => {
    for (const fixture of [stCardV2(), cardV3()]) {
      for (const path of paths(fixture)) {
        for (const value of HOSTILE) {
          check(
            importCard(json(replaced(fixture, path, value))),
            (result) => Schema.decodeUnknownSync(CardDoc)(result.card),
            `${path.join(".")} = ${JSON.stringify(value)}`
          )
        }
      }
    }
  })

  it("always produce a lorebook the schema accepts", () => {
    const fixture = worldInfo()
    for (const path of paths(fixture)) {
      for (const value of HOSTILE) {
        check(
          importLorebook(json(replaced(fixture, path, value))),
          (result) => Schema.decodeUnknownSync(LorebookDoc)(result.lorebook),
          `${path.join(".")} = ${JSON.stringify(value)}`
        )
      }
    }
    for (const key of ["100000000000000000000000", "9007199254740993", "-1", "1e3"]) {
      check(
        importLorebook(json({ entries: { [key]: { key: ["k"], content: "c" } } })),
        (result) => Schema.decodeUnknownSync(LorebookDoc)(result.lorebook),
        `key ${key}`
      )
    }
  })
})
