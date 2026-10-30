import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Snippet } from "@rp/shared/snippetsApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { SnippetWorkspace } from "../src/features/snippets/workspace.ts"
import type { Caller } from "../src/features/editor/caller.ts"

const id = "synthetic-snippet" as RefId
const snippet = (content: string, revision = "r0"): Snippet =>
  ({
    ref: { id },
    title: "Harbour",
    content,
    revision,
    global: true,
    draft: null
  }) as Snippet
const tick = () => new Promise((done) => setTimeout(done, 0))
const setup = (empty = false) => {
  let saved = snippet("First")
  let exists = !empty
  let conflict = false
  let pause: Promise<void> | null = null
  let restorePause: Promise<void> | null = null
  let n = 0
  const calls: Array<{ tag: string; args: Record<string, unknown> }> = []
  const rpc = (tag: string, args: Record<string, unknown>) =>
    Effect.promise(async () => {
      calls.push({ tag, args })
      if (tag === "ListSnippets") return exists ? [saved] : []
      if (tag === "CreateSnippet") {
        exists = true
        saved = snippet(args.content as string)
        return saved
      }
      if (tag === "SaveSnippet") {
        if (pause) await pause
        if (conflict) throw new Error("simulated stale revision")
        saved = { ...saved, title: args.title as string, content: args.content as string, revision: `r${++n}` as never }
        return saved
      }
      if (tag === "RestoreSnippet") {
        if (restorePause) await restorePause
        saved = snippet("Earlier", `r${++n}`)
        return saved
      }
      return saved
    })
  const call = (async (invoke) => {
    try {
      return { ok: true, value: await Effect.runPromise(invoke(rpc as never)) }
    } catch {
      return { ok: false, error: { tag: "StaleWrite", message: "Changed in another tab", problems: [] } }
    }
  }) as Caller
  return {
    store: new SnippetWorkspace(call, "synthetic-user"),
    calls,
    conflict: () => {
      conflict = true
    },
    pause: (promise: Promise<void>) => {
      pause = promise
    },
    pauseRestore: (promise: Promise<void>) => {
      restorePause = promise
    },
    remote: (content: string) => {
      saved = snippet(content, "remote")
    }
  }
}
afterEach(() => vi.unstubAllGlobals())
describe("snippet workspace", () => {
  it("keeps unsaved text and its browser copy when Delete cannot save it", async () => {
    const backup = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backup.get(k) ?? null,
      setItem: (k: string, v: string) => backup.set(k, v),
      removeItem: (k: string) => backup.delete(k)
    })
    const h = setup()
    await h.store.refresh()
    h.conflict()
    h.store.change(id, { content: "Only in this browser" })
    expect(await h.store.remove(id)).toBeNull()
    expect(h.calls.some((c) => c.tag === "DeleteNote")).toBe(false)
    expect(h.store.snapshot().items[0]!.content).toBe("Only in this browser")
    expect([...backup.values()][0]).toContain("Only in this browser")
    expect(h.store.snapshot().error).toContain("Your text is kept here")
  })
  it("keeps typing made while Restore is in flight, then saves it on the restored revision", async () => {
    const h = setup()
    await h.store.refresh()
    let release!: () => void
    h.pauseRestore(
      new Promise<void>((done) => {
        release = done
      })
    )
    const restoring = h.store.restore(id, 0)
    await tick()
    h.store.change(id, { content: "Typed while restoring", title: "New name" })
    release()
    await restoring
    await h.store.save(id)
    expect(h.store.snapshot().items[0]).toMatchObject({ content: "Typed while restoring", title: "New name" })
    expect(h.calls.find((c) => c.tag === "SaveSnippet")!.args).toMatchObject({
      content: "Typed while restoring",
      title: "New name",
      expectedRevision: "r1"
    })
  })
  it("waits for pending text before deleting and makes that snippet read-only until it finishes", async () => {
    const h = setup()
    await h.store.refresh()
    let release!: () => void
    h.pause(
      new Promise<void>((done) => {
        release = done
      })
    )
    h.store.change(id, { content: "Text to keep in the bin" })
    const deleting = h.store.remove(id)
    await tick()
    expect(h.calls.some((call) => call.tag === "DeleteNote")).toBe(false)
    expect(h.store.snapshot().deleting).toBe(id)
    h.store.change(id, { content: "An event from a field now read-only" })
    expect(h.store.snapshot().items[0]!.content).toBe("Text to keep in the bin")
    release()
    await deleting
    const writes = h.calls.filter((call) => ["SaveSnippet", "DeleteNote"].includes(call.tag))
    expect(writes.map((call) => call.tag)).toEqual(["SaveSnippet", "DeleteNote"])
    expect(writes[0]!.args.content).toBe("Text to keep in the bin")
    expect(h.store.snapshot().deleting).toBeNull()
  })
  it("keeps edits typed while a save is in flight and serializes their revision bases", async () => {
    const h = setup()
    await h.store.refresh()
    let release!: () => void
    h.pause(
      new Promise<void>((done) => {
        release = done
      })
    )
    h.store.change(id, { content: "Second" })
    await tick()
    h.store.change(id, { content: "Third" })
    release()
    await h.store.save(id)
    expect(h.store.snapshot().items[0]!.content).toBe("Third")
    const saves = h.calls.filter((c) => c.tag === "SaveSnippet")
    expect(saves.map((c) => c.args.expectedRevision)).toEqual(["r0", "r1"])
    expect(saves.map((c) => c.args.content)).toEqual(["Second", "Third"])
  })
  it("keeps conflicted text and browser recovery when refresh reads another tab's edit", async () => {
    const backup = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backup.get(k) ?? null,
      setItem: (k: string, v: string) => backup.set(k, v),
      removeItem: (k: string) => backup.delete(k)
    })
    const h = setup()
    await h.store.refresh()
    h.conflict()
    h.store.change(id, { content: "My unsaved passage" })
    await h.store.save(id)
    h.remote("Their passage")
    await h.store.refresh()
    expect(h.store.snapshot().items[0]!.content).toBe("My unsaved passage")
    expect(h.store.snapshot().error).toContain("Your text is kept here")
    expect([...backup.values()][0]).toContain("My unsaved passage")
  })
  it("refreshes clean text from another tab and appends selected text to the open snippet", async () => {
    const h = setup()
    await h.store.refresh()
    h.remote("Tide")
    await h.store.refresh()
    h.store.send("Lantern")
    await h.store.save(id)
    expect(h.store.snapshot().items[0]!.content).toBe("Tide\nLantern")
  })
  it("sends selected text after a pending scope change has loaded its snippets", async () => {
    const h = setup()
    await h.store.refresh()
    h.store.setScope({ chatId: "next-chat" as never, forkId: "next-fork" as never })
    h.store.send("Carried passage")
    await h.store.save(id)
    expect(h.store.snapshot().items[0]!.content).toBe("First\nCarried passage")
    expect(h.calls.filter((c) => c.tag === "SaveSnippet")[0]!.args.chatId).toBe("next-chat")
  })
  it("saves a sent passage before a following scope change", async () => {
    const h = setup()
    await h.store.refresh()
    h.store.send("Carry this passage")
    h.store.setScope({ chatId: "next-chat" as never, forkId: "next-fork" as never })
    await h.store.refresh()
    expect(h.calls.filter((c) => c.tag === "SaveSnippet").map((c) => c.args.content)).toEqual([
      "First\nCarry this passage"
    ])
    expect(h.calls.find((c) => c.tag === "SaveSnippet")!.args.chatId).toBeNull()
    expect(h.store.snapshot().items[0]!.content).toBe("First\nCarry this passage")
  })
  it("creates once and appends rapid sends before leaving the empty workspace's scope", async () => {
    const h = setup(true)
    await h.store.refresh()
    h.store.send("First passage")
    h.store.send("Second passage")
    h.store.setScope({ chatId: "next-chat" as never, forkId: "next-fork" as never })
    await h.store.refresh()
    const writes = h.calls.filter((c) => c.tag !== "ListSnippets")
    expect(writes.map((c) => c.tag)).toEqual(["CreateSnippet", "SaveSnippet"])
    expect(writes.map((c) => c.args.chatId)).toEqual([null, null])
    expect(h.store.snapshot().items[0]!.content).toBe("First passage\nSecond passage")
  })
})
