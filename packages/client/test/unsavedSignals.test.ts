// What tells an editor's store that its entry may have changed elsewhere (libraryChanges.ts), and
// the places that must say so: every delete's toast, a revert or discard (for another store or
// tab on the same entry), and another tab's draft-only change, which mustn't make lists read again.
import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"
import { textField } from "@dreamspan/shared/editing.ts"
import { Draft, DraftKey } from "@dreamspan/shared/drafts.ts"
vi.hoisted(() => {
  const target = new EventTarget()
  vi.stubGlobal("window", target)
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" })
})
vi.mock("../src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/backup.ts")>()),
  copiesOf: async () => [],
  keepCopy: async () => {},
  dropCopy: async () => {}
}))
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: <F>(f: F) => f,
  useContext: () => ({})
}))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }))
vi.mock("../src/ui/Toast.tsx", () => ({ showToast: () => {} }))
import type { BinItem } from "@dreamspan/shared/bin.ts"
import { useDeletedManyToast, useDeletedToast } from "../src/features/bin/deleted.ts"
import type { Caller } from "../src/features/editor/caller.ts"
import { EditorStore } from "../src/features/editor/store.ts"
import { notifyLibraryChange, onEntriesChanged, onLibraryChange } from "../src/libraryChanges.ts"
import { UnsavedTracker } from "../src/ui/UnsavedChanges.tsx"

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

it("every delete's toast tells editors to read their entries again", () => {
  const heard = vi.fn()
  stops.push(onEntriesChanged(heard))
  useDeletedToast()({ id: "item", kind: "branch", title: "Branch", excerpt: "", origin: {} } as unknown as BinItem)
  expect(heard).toHaveBeenCalledTimes(1)
  useDeletedManyToast()([{ id: "a", kind: "message", title: "A", excerpt: "", origin: {} } as unknown as BinItem])
  expect(heard).toHaveBeenCalledTimes(2)
})

it("another tab's draft-only change reaches editors, not lists; a library change reaches both", async () => {
  const editors = vi.fn()
  const lists = vi.fn()
  stops.push(onEntriesChanged(editors), onLibraryChange(lists))
  const otherTab = new BroadcastChannel("dreamspan.library")
  const heardThere: Array<unknown> = []
  otherTab.onmessage = (event) => heardThere.push(event.data)
  otherTab.postMessage("entries")
  await settle()
  expect(editors).toHaveBeenCalledTimes(1)
  expect(lists).toHaveBeenCalledTimes(0)
  otherTab.postMessage("changed")
  await settle()
  expect(editors).toHaveBeenCalledTimes(2)
  expect(lists).toHaveBeenCalledTimes(1)
  // This tab's own draft-only write is told to other tabs as such.
  notifyLibraryChange(["drafts"])
  await settle()
  expect(heardThere).toEqual(["entries"])
  otherTab.close()
})

const draft = (content: string) =>
  new Draft({
    id: "draft",
    key: new DraftKey({ targetKind: "entity_field", targetId: "ref", field: textField(["content"]) }),
    content,
    status: "active",
    rowVersion: 1,
    clearedVersion: 0,
    session: 1,
    baseRevision: "revision",
    createdAt: 1,
    updatedAt: 1,
    historyLength: 1,
    recovered: 0,
    displaced: null
  })

it("a revert in one store clears the markers of another store on the same entry", async () => {
  const entry = { drafts: [draft("typed, not saved")] }
  const invalidated: Array<ReadonlyArray<string>> = []
  // As the real caller does: a write's keys are told to the page (caller.ts).
  const call = (async (
    use: (client: (tag: string) => Effect.Effect<unknown>) => Effect.Effect<unknown>,
    invalidates: ReadonlyArray<string> = []
  ) => {
    const value = await Effect.runPromise(
      use((tag) => {
        if (tag === "RevertEditorDrafts") {
          entry.drafts = []
          return Effect.succeed({})
        }
        return Effect.succeed({
          ref: { id: "ref", kind: "note", headRevisionId: "revision", label: "Synthetic" },
          doc: { content: "saved" },
          drafts: entry.drafts
        })
      })
    )
    if (invalidates.length > 0) {
      invalidated.push(invalidates)
      notifyLibraryChange(invalidates)
    }
    return { ok: true, value }
  }) as unknown as Caller
  const env = { setTimer: () => 0, clearTimer: () => {}, now: () => 1, keepalive: async () => false }
  const panel = new EditorStore("ref" as never, "synthetic", call, env)
  const large = new EditorStore("ref" as never, "synthetic", call, env)
  await panel.load()
  await large.load()
  const tracker = new UnsavedTracker()
  tracker.add("notes", panel.unsavedSource)
  expect(tracker.snapshot().has("notes")).toBe(true)
  await large.revert()
  await settle()
  expect(invalidated).toContainEqual(["drafts"])
  expect(tracker.snapshot().has("notes")).toBe(false)
  tracker.dispose()
})
