import { expect, it } from "vitest"
import { makeTokenMemo } from "../src/importer/localTokenMemo.ts"

it("keys exact text and encoding, including edits and a model/encoding switch", () => {
  const memo = makeTokenMemo(500, 10)
  let calls = 0
  const first = memo("first", (text) => {
    calls++
    return text.length
  })
  const second = memo("second", (text) => {
    calls++
    return text.length + 100
  })
  expect(first("same text")).toBe(9)
  expect(first("same text")).toBe(9)
  expect(first("same text edited")).toBe(16)
  expect(second("same text")).toBe(109)
  expect(first("same text")).toBe(9)
  expect(calls).toBe(3)
})

it("evicts by characters and entries while hundreds of branches pass through it", () => {
  let calls = 0
  const count = makeTokenMemo(48, 2)("local", (text) => {
    calls++
    return text.length
  })
  for (let n = 0; n < 400; n++) expect(count(`branch ${n}`)).toBe(`branch ${n}`.length)
  expect(calls).toBe(400)
  count("branch 399")
  expect(calls).toBe(400)
  count("branch 0")
  expect(calls).toBe(401)
  count("x".repeat(100))
  count("x".repeat(100))
  expect(calls).toBe(403)
  // The large entry was never retained and did not evict the current short entry.
  count("branch 0")
  expect(calls).toBe(403)
})

it("does not cache a failed count", () => {
  let fail = true
  const count = makeTokenMemo()("local", () => {
    if (fail) throw new Error("synthetic tokenizer failure")
    return 7
  })
  expect(() => count("same")).toThrow("synthetic tokenizer failure")
  fail = false
  expect(count("same")).toBe(7)
})
