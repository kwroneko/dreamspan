import { expect, test } from "vitest"
import { AT_START, BEFORE_CHAT, placeReuseLines, reuseByMessage } from "../src/features/editor/promptLines.tsx"

const order = ["main", "worldInfoBefore", "charDescription", "chatHistory", "jailbreak"]

test("every assembler breakpoint survives, including points projected onto one row", () => {
  const points = [
    { identifier: "chatHistory", reason: "history" },
    { identifier: "main", reason: "prefix" },
    { identifier: "worldInfoBefore", reason: "pinned" },
    { identifier: "summaries", reason: "summary" },
    { identifier: "main", reason: "pinned" }
  ] as const
  const lines = placeReuseLines(points, order)
  expect([...lines.values()].flat()).toHaveLength(points.length)
  expect(lines.get("main")).toEqual(["prefix", "pinned"])
  expect(lines.get("summaries")).toEqual(["summary"])
})

test("parts without editor rows retain all their breakpoints", () => {
  expect(
    placeReuseLines([{ identifier: "utility.new_chat_prompt", reason: "prefix" }], order).get(BEFORE_CHAT)
  ).toEqual(["prefix"])
  expect(placeReuseLines([{ identifier: "utility.x", reason: "prefix" }], ["main"]).get(AT_START)).toEqual(["prefix"])
  expect(placeReuseLines([], order).size).toBe(0)
})

test("the inspector retains its existing projection", () => {
  expect([...reuseByMessage([undefined, "prefix", "pinned", undefined, "history", undefined])]).toEqual([
    [1, "every"],
    [4, "until"]
  ])
})
