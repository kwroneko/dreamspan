// A library field in its own tab (owner, 2026-11-23; editor/fieldTab.ts): its URL round-trips,
// one tab per entry and field, its title, and its kind opening where a field's tab is showing. A
// chat's own texts (its own note, a summary, the summarization instruction) the same way.
import type { ChatNotePosition } from "@dreamspan/shared/editorApi.ts"
import { textField, valueField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { createMemoryHistory } from "@tanstack/react-router"
import { afterEach, expect, it, vi } from "vitest"
import {
  fieldTabHref,
  fieldTabKey,
  fieldTabKind,
  fieldTabName,
  fieldTabTarget,
  fieldTabTitle,
  instructionTabHref,
  instructionTabTarget,
  summaryTabHref,
  summaryTabTarget
} from "../src/features/editor/fieldTab.ts"
import { itemKey, tabKinds } from "../src/features/workbench/kinds.ts"
import { focusedTab } from "../src/features/workbench/model.ts"
import { WorkbenchStore } from "../src/features/workbench/store.ts"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const url = (href: string) => new URL(href, "http://tab.invalid")
const ref = "r-1" as RefId

it("names a text field, a list's item, and refuses what isn't one", () => {
  const description = fieldTabHref({
    refId: ref,
    field: textField(["description"]),
    path: ["description"],
    label: "Description"
  })
  expect(description).toBe(`/library/r-1/field?field=${encodeURIComponent('["description"]')}&label=Description`)
  expect(fieldTabTarget(url(description))).toEqual({
    refId: ref,
    field: '["description"]',
    path: ["description"],
    label: "Description"
  })
  // An alternate greeting: its list's draft, its own place.
  const greeting = fieldTabHref({
    refId: ref,
    field: valueField(["alternate_greetings"]),
    path: ["alternate_greetings", 1],
    label: "Alternate greeting 2"
  })
  expect(fieldTabTarget(url(greeting))?.path).toEqual(["alternate_greetings", 1])
  // A source's card's placeholder id survives the path.
  const remote = fieldTabHref({
    refId: "src:fake:card 1" as RefId,
    field: textField(["scenario"]),
    path: ["scenario"],
    label: "Scenario"
  })
  expect(fieldTabTarget(url(remote))?.refId).toBe("src:fake:card 1")
  // A chat's binding rides along, as the entry's editor tab has it.
  const bound = fieldTabHref(
    { refId: ref, field: textField(["description"]), path: ["description"], label: "Description" },
    { chat: "c1", chatFork: "f1", chatTab: "t1" }
  )
  expect(url(bound).searchParams.get("chat")).toBe("c1")
  expect(url(bound).searchParams.get("chatFork")).toBe("f1")
  expect(url(bound).searchParams.get("chatTab")).toBe("t1")

  expect(fieldTabTarget(url("/library/r-1/field"))).toBeNull()
  expect(fieldTabTarget(url("/library/r-1?field=%5B%22description%22%5D"))).toBeNull()
  expect(fieldTabTarget(url("/library/r-1/field?field=not-json"))).toBeNull()
  // A text field's path must be its own; a list's path one item into it.
  expect(
    fieldTabTarget(url(`/library/r-1/field?field=${encodeURIComponent('["a"]')}&path=${encodeURIComponent('["b"]')}`))
  ).toBeNull()
  expect(
    fieldTabTarget(
      url(`/library/r-1/field?field=${encodeURIComponent('=["a"]')}&path=${encodeURIComponent('["a","x"]')}`)
    )
  ).toBeNull()
})

it("is one tab per entry and field, titled by the field until the entry names it", () => {
  const href = (path: ReadonlyArray<string | number>, label: string, chat?: string) =>
    fieldTabHref({ refId: ref, field: textField(path), path, label }, chat === undefined ? undefined : { chat })
  const a = url(href(["description"], "Description"))
  expect(fieldTabKey(a)).toBe(fieldTabKey(url(href(["description"], "Description", "c1"))))
  expect(fieldTabKey(a)).not.toBe(fieldTabKey(url(href(["scenario"], "Scenario"))))
  expect(fieldTabKey(url("/library/r-1"))).toBeNull()
  expect(fieldTabTitle(a)).toBe("Description")
  expect(fieldTabName("Mira", "Description")).toBe("Mira · Description")
  expect(fieldTabName("", "Description")).toBe("Description")
})

it("names a chat's own note at its branch position, a summary and the instruction under their chat", () => {
  const at = { chatId: "c1", forkId: "f1", slotId: "s9" } as ChatNotePosition
  const note = fieldTabHref({
    refId: ref,
    field: textField(["content"]),
    path: ["content"],
    label: "Text",
    chatNote: at
  })
  expect(url(note).pathname).toBe("/chats/c1/notes/r-1/field")
  expect(fieldTabTarget(url(note))).toEqual({
    refId: ref,
    field: '["content"]',
    path: ["content"],
    label: "Text",
    chatNote: at
  })
  // The same note at another position, or the entry in the library, is another tab.
  const elsewhere = fieldTabHref({
    refId: ref,
    field: textField(["content"]),
    path: ["content"],
    label: "Text",
    chatNote: { ...at, slotId: "s10" } as ChatNotePosition
  })
  const library = fieldTabHref({ refId: ref, field: textField(["content"]), path: ["content"], label: "Text" })
  expect(new Set([note, elsewhere, library].map((href) => fieldTabKey(url(href)))).size).toBe(3)
  // The main branch has no fork, and a position with no slot names none.
  const main = fieldTabHref({
    refId: ref,
    field: textField(["content"]),
    path: ["content"],
    label: "Text",
    chatNote: { chatId: "c1", forkId: null, slotId: null } as ChatNotePosition
  })
  expect(fieldTabTarget(url(main))?.chatNote).toEqual({ chatId: "c1", forkId: null, slotId: null })

  const summary = summaryTabHref({ chatId: "c1", forkId: "f1", summaryId: "sum-1", label: "Summary of messages 1–20" })
  expect(url(summary).pathname).toBe("/chats/c1/summaries/sum-1/text")
  expect(summaryTabTarget(url(summary))).toEqual({
    chatId: "c1",
    forkId: "f1",
    summaryId: "sum-1",
    label: "Summary of messages 1–20"
  })
  expect(fieldTabTitle(url(summary))).toBe("Summary of messages 1–20")
  expect(fieldTabKey(url(summary))).not.toBe(
    fieldTabKey(url(summaryTabHref({ chatId: "c1", forkId: null, summaryId: "sum-1", label: "Summary" })))
  )
  expect(summaryTabTarget(url("/chats/c1/summaries/sum-1/request"))).toBeNull()

  const instruction = instructionTabHref({ chatId: "c1", forkId: "f1", leafSlotId: "s9" })
  expect(instruction).toBe("/chats/c1/instruction?fork=f1&leaf=s9")
  expect(instructionTabTarget(url(instruction))).toEqual({ chatId: "c1", forkId: "f1", leafSlotId: "s9" })
  expect(instructionTabHref({ chatId: "c1", forkId: null, leafSlotId: null })).toBe("/chats/c1/instruction")
  expect(fieldTabTitle(url(instruction))).toBe("Summarization instruction")
  // One instruction tab per chat and branch, wherever on it it's opened.
  expect(fieldTabKey(url(instruction))).toBe(
    fieldTabKey(url(instructionTabHref({ chatId: "c1", forkId: "f1", leafSlotId: "s3" })))
  )
  expect(fieldTabKey(url("/chats/c1"))).toBeNull()
})

it("opens a second field where a field is showing, the editor keeping its frame", () => {
  vi.useFakeTimers()
  vi.stubGlobal("window", new EventTarget())
  const dispose = tabKinds.register(fieldTabKind)
  const description = fieldTabHref({
    refId: ref,
    field: textField(["description"]),
    path: ["description"],
    label: "Description"
  })
  const scenario = fieldTabHref({ refId: ref, field: textField(["scenario"]), path: ["scenario"], label: "Scenario" })
  const greeting = fieldTabHref({
    refId: ref,
    field: textField(["first_mes"]),
    path: ["first_mes"],
    label: "First message"
  })
  expect(itemKey(description)).toBe(`library.field:${fieldTabKey(url(description))}`)
  const store = new WorkbenchStore(
    "user",
    createMemoryHistory({ initialEntries: ["/library/r-1"] }),
    null,
    () => {},
    () => true
  )
  const editor = focusedTab(store.layout)!.id
  const editorFrame = store.frames()[0]!.id
  store.pin(editor)
  store.openBeside(description)
  store.focusTab(editor)
  // From the editor's frame, the next field goes to the field's frame, after the kept one.
  store.openIn(editorFrame, scenario)
  const [left, right] = store.frames()
  expect(left!.tabs.map((tab) => tab.href)).toEqual(["/library/r-1"])
  expect(right!.tabs.map((tab) => tab.href)).toEqual([description, scenario])
  // An italic field there gives its place to the next.
  store.focusTab(editor)
  store.openIn(editorFrame, greeting)
  expect(store.frames()[1]!.tabs.map((tab) => tab.href)).toEqual([description, greeting])
  dispose()
  vi.runAllTimers()
})

it("opens a chat's summary where a field's tab is showing, the chat keeping its frame", () => {
  vi.useFakeTimers()
  vi.stubGlobal("window", new EventTarget())
  const dispose = tabKinds.register(fieldTabKind)
  const instruction = instructionTabHref({ chatId: "c1", forkId: null, leafSlotId: null })
  const summary = summaryTabHref({ chatId: "c1", forkId: null, summaryId: "sum-1", label: "Summary of message 1" })
  const store = new WorkbenchStore(
    "user",
    createMemoryHistory({ initialEntries: ["/chats/c1"] }),
    null,
    () => {},
    () => true
  )
  const chat = focusedTab(store.layout)!.id
  const chatFrame = store.frames()[0]!.id
  store.pin(chat)
  store.openBeside(instruction)
  store.focusTab(chat)
  store.openIn(chatFrame, summary)
  const [left, right] = store.frames()
  expect(left!.tabs.map((tab) => tab.href)).toEqual(["/chats/c1"])
  expect(right!.tabs.map((tab) => tab.href)).toEqual([instruction, summary])
  dispose()
  vi.runAllTimers()
})
