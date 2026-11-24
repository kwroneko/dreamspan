// The editor's store (spec/FILES-AND-ENVIRONMENT.md §8.2; `features/files/fileDraft.ts`): typing
// is kept as a draft typed on the file's hash; Save writes only onto that hash and ends the draft;
// a file changed underneath shows a conflict and keeps the text; Discard and Save as a copy end it.
import { Draft, fileDraftKey } from "@dreamspan/shared/drafts.ts"
import type { TextFile } from "@dreamspan/shared/files.ts"
import type { FileDraftSave } from "@dreamspan/shared/filesApi.ts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Copy } from "../src/features/editor/backup.ts"

vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "localhost" }))
const memory = vi.hoisted(() => new Map<string, Copy>())
vi.mock("../src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/backup.ts")>()),
  keepCopy: async (copy: Copy, previous?: Copy | null) => {
    memory.set(copy.key, copy)
    if (previous) memory.delete(previous.key)
  },
  dropCopy: async (copy: Copy) => {
    memory.delete(copy.key)
  },
  copiesOf: async () => [...memory.values()]
}))
const { FileDraft } = await import("../src/features/files/fileDraft.ts")
const { FileChanged } = await import("../src/features/files/source.ts")

const PATH = "/files/notes/plan.md"
const A = "a".repeat(64)
const B = "b".repeat(64)
const shaOf = (text: string) => String(text.length).padStart(64, "0")
const file = (
  text: string,
  sha256: string,
  format: Pick<TextFile, "lineEnding" | "bom"> = { lineEnding: "lf", bom: false }
): TextFile => ({ path: PATH, text, ...format, sha256, size: text.length, mtimeMs: 1 })

/** A server with one draft slot and one file, as the RPCs and routes keep them. */
const fake = (initial: TextFile, beforeEndResponse?: () => Promise<void>) => {
  let disk = initial
  let stored: Draft | null = null
  let row = 0
  const calls: Array<string> = []
  const saveDraft = (save: FileDraftSave) => {
    row++
    stored = new Draft({
      id: "draft",
      key: fileDraftKey(PATH),
      content: save.content,
      status: "active",
      baseRevision: save.baseSha256,
      rowVersion: row,
      session: stored?.session ?? 1,
      createdAt: 1,
      updatedAt: row,
      recovered: 0,
      displaced: null,
      historyLength: row
    })
    return stored
  }
  const client = (tag: string, payload: Record<string, unknown>) => {
    calls.push(tag)
    if (tag === "GetFileDraft") return stored
    if (tag === "SaveFileDraft") return saveDraft(payload as unknown as FileDraftSave)
    if (tag === "EndFileDraft") {
      stored = new Draft({
        ...stored!,
        status: payload.outcome as "committed",
        content: "",
        rowVersion: ++row,
        session: stored!.session + 1
      })
      return stored
    }
    throw new Error(tag)
  }
  const run = (async (call: (c: unknown) => unknown) => {
    // The store's calls are `client(tag, payload)` returning an Effect; here they return values.
    const value = call((tag: string, payload: Record<string, unknown>) => client(tag, payload))
    if (value instanceof Draft && value.status === "committed") await beforeEndResponse?.()
    return { ok: true, value }
  }) as never
  const source = {
    saveText: async (_path: string, text: string, base: string, format: Pick<TextFile, "lineEnding" | "bom">) => {
      calls.push(`saveText:${base}`)
      calls.push(`format:${format.lineEnding}${format.bom ? "+bom" : ""}`)
      if (base !== disk.sha256) throw new FileChanged("It changed since you opened it.")
      disk = file(text, shaOf(text), format)
      return { path: PATH, outcome: "replaced" as const, sha256: disk.sha256 }
    }
  } as never
  return {
    run,
    source,
    calls,
    disk: () => disk,
    setDisk: (next: TextFile) => {
      disk = next
    },
    draft: () => stored
  }
}

beforeEach(() => {
  memory.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it("keeps typing as a draft on the file's hash, and Save writes onto that hash and ends it", async () => {
  const server = fake(file("First.", A))
  const store = new FileDraft(server.run, server.source, "user", PATH, server.disk())
  await store.open()
  expect(store.snapshot()).toMatchObject({ loading: false, text: "First.", changed: false, conflict: false })
  store.setText("First. More.")
  expect(store.snapshot()).toMatchObject({ unsaved: true, changed: true })
  expect(memory.size).toBe(1)
  await store.saveDraft()
  expect(server.draft()).toMatchObject({ content: "First. More.", baseRevision: A })
  expect(memory.size).toBe(0)

  const saved = await store.save()
  expect(saved).toMatchObject({
    before: { text: "First." },
    after: { text: "First. More.", sha256: shaOf("First. More.") }
  })
  expect(server.calls).toContain(`saveText:${A}`)
  expect(server.draft()?.status).toBe("committed")
  expect(store.snapshot()).toMatchObject({ text: "First. More.", changed: false, conflict: false })
})

it("a file changed underneath shows a conflict, keeps the text, and Save writes nothing", async () => {
  const server = fake(file("First.", A))
  const store = new FileDraft(server.run, server.source, "user", PATH, server.disk())
  await store.open()
  store.setText("Mine.")
  await store.saveDraft()
  // A command rewrote it; the live refresh reads it again.
  server.setDisk(file("Theirs.", B))
  store.update(server.disk())
  expect(store.snapshot()).toMatchObject({ text: "Mine.", conflict: true })
  expect(await store.save()).toBe("changed")
  expect(server.disk().text).toBe("Theirs.")
  expect(server.draft()?.content).toBe("Mine.")

  // Load the latest: the edit is discarded (its text to the recovered texts), the file shows.
  expect(await store.discard(server.disk())).toBe(true)
  expect(server.draft()?.status).toBe("discarded")
  expect(store.snapshot()).toMatchObject({ text: "Theirs.", conflict: false, changed: false })
})

it.each([false, true])("keeps edits typed during Save as a copy (autosaved: %s)", async (autosaved) => {
  const server = fake(file("First.", A))
  const store = new FileDraft(server.run, server.source, "user", PATH, server.disk())
  await store.open()
  store.setText("Copied text.")
  store.update(file("Changed on disk.", B))
  const uploaded = Promise.withResolvers<void>()
  const saving = store.saveCopy((text) => {
    expect(text).toBe("Copied text.")
    return uploaded.promise
  })
  store.setText("Copied text. More typing.")
  if (autosaved) await store.saveDraft()
  uploaded.resolve()
  await saving
  expect(store.snapshot()).toMatchObject({ text: "Copied text. More typing.", conflict: true, unsaved: !autosaved })
  await store.flush()
  expect(server.draft()).toMatchObject({ status: "active", content: "Copied text. More typing.", baseRevision: A })
  expect(server.calls).not.toContain("EndFileDraft")
})

it("backs up typing during the copy's draft commit against the new session", async () => {
  const ending = Promise.withResolvers<void>()
  const respond = Promise.withResolvers<void>()
  const server = fake(file("First.", A), () => {
    ending.resolve()
    return respond.promise
  })
  const store = new FileDraft(server.run, server.source, "user", PATH, server.disk())
  await store.open()
  store.setText("Copied text.")
  store.update(file("Changed on disk.", B))
  const saving = store.saveCopy(async () => {})
  await ending.promise
  store.setText("Copied text. More typing.")
  respond.resolve()
  await saving

  expect([...memory.values()].map((copy) => copy.save)).toMatchObject([
    { kind: "file", payload: { content: "Copied text. More typing.", expectedSession: 2, baseSha256: A } }
  ])
  await store.flush()
  expect(server.draft()).toMatchObject({ status: "active", content: "Copied text. More typing.", baseRevision: A })
})

it("reopening finds the draft, and a copy never sent is replayed onto it", async () => {
  const server = fake(file("First.", A))
  const first = new FileDraft(server.run, server.source, "user", PATH, server.disk())
  await first.open()
  first.setText("Typed, then the tab closed.")
  // The tab closed before the debounced save: only the browser copy has it.
  expect(server.draft()).toBeNull()
  const again = new FileDraft(server.run, server.source, "user", PATH, server.disk())
  await again.open()
  expect(server.draft()).toMatchObject({ content: "Typed, then the tab closed.", baseRevision: A })
  expect(again.snapshot()).toMatchObject({ text: "Typed, then the tab closed.", changed: true, conflict: false })
})

it("Save writes the file's own line breaks and byte order mark back", async () => {
  // review files4b finding 4: a CRLF file with a BOM saved as LF without it.
  const server = fake(file("One\nTwo", A, { lineEnding: "crlf", bom: true }))
  const store = new FileDraft(server.run, server.source, "user", PATH, server.disk())
  await store.open()
  store.setText("One\nTwo\nThree")
  await store.save()
  expect(server.calls).toContain("format:crlf+bom")
  expect(server.disk()).toMatchObject({ lineEnding: "crlf", bom: true })
})
