import { expect, test } from "vitest"
import { exportFormats } from "../src/features/chat/chatExportText.ts"
import type { ChatView } from "../src/features/chat/session.ts"

// ⋯ Export offers the files the chat's kind makes; the server writes them (its tests cover
// their content: server/test/formats/stChatExport.test.ts, server/test/chatExport.test.ts).
const view = { chat: { kind: "rp", title: "Aria", createdAt: Date.UTC(2026, 0, 2) } } as unknown as ChatView

test("A roleplay exports as SillyTavern .jsonl or plain text", () => {
  expect(exportFormats(view)).toEqual(["jsonl", "txt"])
})

test("Workshop exports permit plain text and refuse SillyTavern", () => {
  expect(exportFormats({ ...view, chat: { ...view.chat!, kind: "workshop" } })).toEqual(["txt"])
})

test("An unknown kind offers no export", () => {
  expect(exportFormats({ ...view, chat: { ...view.chat!, kind: "unknown" } } as ChatView)).toEqual([])
})
