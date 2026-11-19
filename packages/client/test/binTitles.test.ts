import { expect, test } from "vitest"
import { BinItem } from "@dreamspan/shared/bin.ts"
import { formatDay } from "../src/features/chat/chatTitle.ts"
import { binTitle, recoveredSource } from "../src/features/bin/titles.ts"

test("bin readable chat names preserve quotes in an imported group name", () => {
  const title = 'The "Lantern" Inn: 2026-4-3@18h00m00s000ms'
  const day = formatDay(new Date(Date.UTC(2026, 3, 3, 18)))
  const item = new BinItem({
    id: "bin",
    kind: "version",
    targetId: "version",
    title: `Version of a message in "${title}"`,
    excerpt: "",
    origin: { chatTitle: title },
    byteSize: 0,
    deletedAt: 0
  })
  expect(binTitle(item)).toBe(`Version of a message in “The "Lantern" Inn, started ${day}”`)
})

test("bin labels use structured kind and origin rather than arbitrary display quotes", () => {
  for (const [kind, label] of [
    ["message", "Message"],
    ["version", "Version of a message"],
    ["branch", "Branch of 3 messages"]
  ] as const) {
    const item = new BinItem({
      id: "bin",
      kind,
      targetId: "target",
      title: 'Stale "display" text',
      excerpt: "",
      origin: { chatTitle: 'The "Lantern" Inn', messages: 3 },
      byteSize: 0,
      deletedAt: 0
    })
    expect(binTitle(item)).toBe(`${label} in “The "Lantern" Inn”`)
  }
})

test("recovered sources preserve embedded quotes using the source kind's full label format", () => {
  const title = 'The "Lantern" Inn: 2026-4-3@18h00m00s000ms'
  const day = formatDay(new Date(Date.UTC(2026, 3, 3, 18)))
  for (const [sourceKind, prefix] of [
    ["composer", "Composer in "],
    ["version_edit", "Edit of a message in "],
    ["scratchpad", "Scratchpad in "],
    ["summary_edit", "Summary in "]
  ] as const) {
    expect(recoveredSource({ sourceKind, sourceLabel: `${prefix}"${title}"` })).toBe(
      `${prefix}“The "Lantern" Inn, started ${day}”`
    )
  }
  expect(recoveredSource({ sourceKind: "entity_field", sourceLabel: `Card "${title}" › name` })).toBe(
    `Card "${title}" › name`
  )
})

test("a message or version in the bin is named by its number in the chat", () => {
  for (const [kind, label] of [
    ["message", "Message 12"],
    ["version", "Version of message 12"]
  ] as const) {
    const item = new BinItem({
      id: "bin",
      kind,
      targetId: "target",
      title: "",
      excerpt: "",
      origin: { chatTitle: "Lighthouse", depth: 11 },
      byteSize: 0,
      deletedAt: 0
    })
    expect(binTitle(item)).toBe(`${label} in “Lighthouse”`)
  }
})

test("a message is numbered by its place where it was deleted, which insertions move off its depth", () => {
  const item = (origin: Record<string, unknown>) =>
    new BinItem({
      id: "bin",
      kind: "message",
      targetId: "t",
      title: "",
      excerpt: "",
      origin,
      byteSize: 0,
      deletedAt: 0
    })
  expect(binTitle(item({ chatTitle: "Lighthouse", depth: 3, position: 4 }))).toBe("Message 5 in “Lighthouse”")
  expect(binTitle(item({ chatTitle: "Lighthouse", depth: 3 }))).toBe("Message 4 in “Lighthouse”")
  expect(binTitle(item({ chatTitle: "Lighthouse" }))).toBe("Message in “Lighthouse”")
})

test("a file another account deleted in a folder you share says who", () => {
  const file = (origin: Record<string, unknown>) =>
    new BinItem({
      id: "bin",
      kind: "file",
      targetId: "/files/A/a.txt",
      title: "a.txt",
      excerpt: "/files/A/a.txt",
      origin,
      byteSize: 2,
      deletedAt: 0
    })
  expect(binTitle(file({ path: "/files/A/a.txt", by: { userId: "u", handle: "ash" } }))).toBe("a.txt, deleted by ash")
  expect(binTitle(file({ path: "/files/A/a.txt" }))).toBe("a.txt")
})
