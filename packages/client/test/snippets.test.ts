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
const setup = () => {
  let saved = snippet("First")
  let conflict = false
  let pause: Promise<void> | null = null
  let n = 0
  const calls: Array<{ tag: string; args: Record<string, unknown> }> = []
  const rpc = (tag: string, args: Record<string, unknown>) =>
    Effect.promise(async () => {
      calls.push({ tag, args })
      if (tag === "ListSnippets") return [saved]
      if (tag === "SaveSnippet") {
        if (pause) await pause
        if (conflict) throw new Error("simulated stale revision")
        saved = { ...saved, title: args.title as string, content: args.content as string, revision: `r${++n}` as never }
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
    remote: (content: string) => {
      saved = snippet(content, "remote")
    }
  }
}
afterEach(() => vi.unstubAllGlobals())
describe("snippet workspace", () => {
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
})
