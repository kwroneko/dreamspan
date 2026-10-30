import { expect, it } from "vitest"
import { isAuthorNote } from "../src/docs/note.ts"

it("the chat's choice of author's note wins over an imported one, and none means none", () => {
  const imported = { kind: "author_note" as const }
  const plain = {}
  // No choice yet: an imported author's note is it.
  expect(isAuthorNote(imported, "a", null)).toBe(true)
  expect(isAuthorNote(plain, "b", null)).toBe(false)
  // A chosen note is the only one, even beside an imported one.
  expect(isAuthorNote(plain, "b", "b")).toBe(true)
  expect(isAuthorNote(imported, "a", "b")).toBe(false)
  // Chose none.
  expect(isAuthorNote(imported, "a", false)).toBe(false)
  expect(isAuthorNote(plain, "b", false)).toBe(false)
})
