// An unsaved marker keeps observing an editor's store after the editor closes; when the entry
// stops existing (deleted, binned, its chat gone) the marker must clear without a reload, and
// come back if the entry is restored with its drafts (features/editor/store.ts, `recheck`).
import { Effect } from "effect"
import { expect, it, vi } from "vitest"
import { textField } from "@dreamspan/shared/editing.ts"
import { Draft, DraftKey } from "@dreamspan/shared/drafts.ts"
vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "localhost" }))
vi.mock("../src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/backup.ts")>()),
  copiesOf: async () => [],
  keepCopy: async () => {},
  dropCopy: async () => {}
}))
import type { Caller } from "../src/features/editor/caller.ts"
import { EditorStore } from "../src/features/editor/store.ts"
import { notifyEntriesChanged } from "../src/libraryChanges.ts"
import { UnsavedTracker } from "../src/ui/UnsavedChanges.tsx"

const draft = (content: string, status: "active" | "committed" = "active") =>
  new Draft({
    id: "draft",
    key: new DraftKey({ targetKind: "entity_field", targetId: "ref", field: textField(["content"]) }),
    content,
    status,
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

/** A server whose entry can be deleted, restored or saved elsewhere. */
const server = () => {
  const entry = { exists: true, head: "saved", drafts: [draft("typed, not saved")] }
  const call = (async (use: (client: (tag: string) => Effect.Effect<unknown, unknown>) => Effect.Effect<unknown>) => {
    let failed: string | null = null
    const value = await Effect.runPromise(
      use((tag) => {
        if (tag !== "OpenEditor") return Effect.die(`unexpected ${tag}`)
        if (!entry.exists) {
          failed = "NotFound"
          return Effect.succeed(null)
        }
        return Effect.succeed({
          ref: { id: "ref", kind: "note", headRevisionId: "revision", label: "Synthetic" },
          doc: { content: entry.head },
          drafts: entry.drafts
        })
      })
    )
    return failed === null
      ? { ok: true, value }
      : { ok: false, error: { tag: failed, message: "Not found", reason: null, problems: [] }, cause: null }
  }) as unknown as Caller
  return { entry, call }
}

const env = { setTimer: () => 0, clearTimer: () => {}, now: () => 1, keepalive: async () => false }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const marked = async () => {
  const { entry, call } = server()
  const store = new EditorStore("ref" as never, "synthetic", call, env)
  await store.load()
  const tracker = new UnsavedTracker()
  tracker.add("snippets", store.unsavedSource)
  return { entry, store, tracker }
}

it("an entry deleted with unsaved changes clears every marker observing its store", async () => {
  const { entry, store, tracker } = await marked()
  expect(tracker.snapshot().has("snippets")).toBe(true)
  // The editor closed (its entry deleted) but the marker still observes the store.
  entry.exists = false
  notifyEntriesChanged()
  await settle()
  expect(store.gone).toBe(true)
  expect(store.state().dirty).toBe(0)
  expect(tracker.snapshot().has("snippets")).toBe(false)
  // Restored from the bin with its draft: the marker comes back.
  entry.exists = true
  notifyEntriesChanged()
  await settle()
  expect(store.gone).toBe(false)
  expect(tracker.snapshot().has("snippets")).toBe(true)
  tracker.dispose()
})

it("changes saved or discarded elsewhere clear the marker", async () => {
  const { entry, tracker } = await marked()
  expect(tracker.snapshot().has("snippets")).toBe(true)
  entry.head = "typed, not saved"
  entry.drafts = [draft("typed, not saved", "committed")]
  notifyEntriesChanged()
  await settle()
  expect(tracker.snapshot().has("snippets")).toBe(false)
  tracker.dispose()
})

it("a store no marker observes isn't read again", async () => {
  const { entry, store, tracker } = await marked()
  tracker.dispose()
  entry.exists = false
  notifyEntriesChanged()
  await settle()
  expect(store.gone).toBe(false)
})
