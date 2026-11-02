import { expect, test } from "vitest"
import { AT_START, BEFORE_CHAT, placeReuseLines, reuseByMessage } from "../src/features/editor/promptLines.tsx"

const order = ["main", "worldInfoBefore", "charDescription", "chatHistory", "jailbreak"]

test("the first kind of reuse line, and only the last of the others", () => {
  const lines = placeReuseLines(
    [
      { identifier: "chatHistory", reason: "history" },
      { identifier: "main", reason: "prefix" },
      { identifier: "worldInfoBefore", reason: "pinned" }
    ],
    order
  )
  expect([...lines]).toEqual([
    ["main", "every"],
    ["chatHistory", "until"]
  ])
})

test("a point inside a part with no row shows just before the chat", () => {
  const lines = placeReuseLines(
    [
      { identifier: "chatHistory", reason: "history" },
      { identifier: "utility.new_chat_prompt", reason: "prefix" }
    ],
    order
  )
  expect(lines.get(BEFORE_CHAT)).toBe("every")
  expect(lines.get("chatHistory")).toBe("until")
  expect(placeReuseLines([{ identifier: "utility.x", reason: "prefix" }], ["main"]).size).toBe(0)
})

test("a later line at or above the first kind's adds nothing", () => {
  expect([
    ...placeReuseLines(
      [
        { identifier: "charDescription", reason: "prefix" },
        { identifier: "worldInfoBefore", reason: "pinned" }
      ],
      order
    )
  ]).toEqual([["charDescription", "every"]])
  expect([...placeReuseLines([{ identifier: AT_START, reason: "summary" }], order)]).toEqual([[AT_START, "until"]])
})

test("the inspector's lines by message", () => {
  expect([...reuseByMessage([undefined, "prefix", "pinned", undefined, "history", undefined])]).toEqual([
    [1, "every"],
    [4, "until"]
  ])
  expect([...reuseByMessage([undefined, "history"])]).toEqual([[1, "until"]])
})
