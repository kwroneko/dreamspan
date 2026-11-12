import { expect, test } from "vitest"
import type { PathEntry } from "@rp/shared/chat.ts"
import { exportFormats, exportText } from "../src/features/chat/chatExportText.ts"
import type { ChatView } from "../src/features/chat/session.ts"

// ⋯ Export: the branch shown, as ST's .jsonl (a header line, then one line per message, the
// version shown) or as plain text, with the names the chat shows.
const view = {
  chat: { kind: "rp", title: "Aria", createdAt: Date.UTC(2026, 0, 2) },
  cast: {
    participants: ["aria", "sam"],
    playedByMe: ["sam"],
    cards: [
      { entityId: "aria", name: "Aria" },
      { entityId: "sam", name: "Sam" }
    ]
  }
} as unknown as ChatView
const entry = (speaker: string | null, writer: "human" | "model", content: string, at: number) =>
  ({
    firstSpeakerEntityId: speaker,
    version: { speakerEntityId: speaker, writer, content, createdAt: at }
  }) as unknown as PathEntry
const entries = [
  entry("aria", "model", "Hello, Sam.", Date.UTC(2026, 0, 2, 10)),
  entry("sam", "human", "Hi.\nTwo lines.", Date.UTC(2026, 0, 2, 10, 1))
]

test("Export as SillyTavern .jsonl: a header line, then each message with its speaker and time", () => {
  const lines = exportText(view, entries, "jsonl")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(lines).toHaveLength(3)
  expect(lines[0]).toMatchObject({ user_name: "Sam", character_name: "Aria", chat_metadata: {} })
  expect(lines[1]).toMatchObject({ name: "Aria", is_user: false, mes: "Hello, Sam." })
  expect(lines[2]).toMatchObject({ name: "Sam", is_user: true, mes: "Hi.\nTwo lines." })
  // ISO 8601, which ST's parseTimestamp and this app's importer both read.
  expect(Date.parse(lines[2]!.send_date as string)).toBe(Date.UTC(2026, 0, 2, 10, 1))
})

test("Export as plain text: who said what, a blank line between messages", () => {
  expect(exportText(view, entries, "txt")).toBe("Aria: Hello, Sam.\n\nSam: Hi.\nTwo lines.\n")
})

test("Workshop exports permit plain text and refuse SillyTavern", () => {
  const workshop = { ...view, chat: { ...view.chat!, kind: "workshop" } }
  expect(exportFormats(workshop)).toEqual(["txt"])
  expect(exportText(workshop, entries, "txt")).toBe(exportText(view, entries, "txt"))
  expect(() => exportText(workshop, entries, "jsonl")).toThrow("does not support")
})
