// The Snippets workspace (owner, 2026-11-01): the chat's snippets and those for all chats, made,
// sent to and moved between the two scopes. Its text edits through editor stores (tested with
// them), so these cover the workspace's own calls. Synthetic text only.
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { Snippet } from "@rp/shared/snippetsApi.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { SnippetWorkspace } from "../src/features/snippets/workspace.ts"
import type { Caller } from "../src/features/editor/caller.ts"

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock("../src/ui/Toast.tsx", () => ({ showToast }))

const snippet = (id: string, content: string, global = false): Snippet =>
  ({ ref: { id: id as RefId }, title: "Harbour", content, global }) as Snippet

const setup = () => {
  const items: Array<Snippet> = []
  const calls: Array<{ tag: string; args: Record<string, unknown> }> = []
  const rpc = (tag: string, args: Record<string, unknown>) =>
    Effect.promise(async () => {
      calls.push({ tag, args })
      if (tag === "ListSnippets") return [...items]
      if (tag === "CreateSnippet") {
        const made = snippet(`s${items.length + 1}`, args.content as string, args.chatId === null)
        items.push(made)
        return made
      }
      if (tag === "SetSnippetScope") {
        const at = items.findIndex((item) => item.ref.id === args.refId)
        items[at] = { ...items[at]!, global: args.global as boolean } as Snippet
        return items[at]
      }
      // Editor stores' reads (a snippet's text) fail here: the workspace's own calls are tested.
      throw new Error(`not mocked: ${tag}`)
    })
  const call = (async (invoke) => {
    try {
      return { ok: true, value: await Effect.runPromise(invoke(rpc as never)) }
    } catch (error) {
      return { ok: false, error: { tag: "ServerError", message: String(error), problems: [] } }
    }
  }) as Caller
  return { workspace: new SnippetWorkspace(call, "synthetic-user"), calls, items }
}

describe("the Snippets workspace", () => {
  it("reads only the final scope when chat providers unmount and remount together", async () => {
    const { workspace, calls } = setup()
    workspace.setChat("chat-1" as ChatId)
    workspace.setChat(null)
    workspace.setChat("chat-2" as ChatId)
    await workspace.refresh()
    expect(calls).toEqual([{ tag: "ListSnippets", args: { chatId: "chat-2" } }])
    // A change after that read still asks the server again.
    await workspace.refresh()
    expect(calls).toHaveLength(2)
  })

  it("lists the chat's snippets, and makes new ones there", async () => {
    const { workspace, calls } = setup()
    workspace.setChat("chat-1" as ChatId)
    await new Promise((done) => setTimeout(done, 0))
    expect(calls[0]).toEqual({ tag: "ListSnippets", args: { chatId: "chat-1" } })
    await workspace.create()
    expect(calls.find((c) => c.tag === "CreateSnippet")?.args).toMatchObject({ chatId: "chat-1", content: "" })
    expect(workspace.snapshot().items).toHaveLength(1)
    expect(workspace.snapshot().selected).toBe("s1")
  })

  it("sends text to a new snippet chosen from the menu, without opening the panel", async () => {
    const { workspace, calls } = setup()
    let opened = 0
    workspace.setOpener(() => opened++)
    expect(workspace.target()).toBeNull()
    await workspace.appendNew("A passage kept from a swipe.")
    expect(opened).toBe(0)
    expect(workspace.snapshot().selected).toBeNull()
    expect(workspace.snapshot().recent).toEqual(["s1"])
    expect(workspace.snapshot().floating).toBe(false)
    const notice = showToast.mock.lastCall![0]
    expect(notice.title).toBe("Added to snippet “Harbour”")
    workspace.select("another-snippet" as RefId)
    notice.actions[0].onClick()
    expect(opened).toBe(1)
    expect(calls.find((c) => c.tag === "CreateSnippet")?.args).toMatchObject({
      chatId: null,
      content: "A passage kept from a swipe."
    })
    expect(workspace.snapshot().selected).toBe("s1")
  })

  it("sends outside a chat without opening the floating sheet until asked", async () => {
    const { workspace } = setup()
    await workspace.appendNew("A synthetic passage.")
    expect(workspace.snapshot().floating).toBe(false)
    showToast.mock.lastCall![0].actions[0].onClick()
    expect(workspace.snapshot().floating).toBe(true)
    expect(workspace.snapshot().selected).toBe("s1")
  })

  it("moves a snippet between this chat and all chats", async () => {
    const { workspace, calls } = setup()
    workspace.setChat("chat-1" as ChatId)
    await workspace.create()
    await workspace.setGlobal("s1" as RefId, true)
    expect(calls.find((c) => c.tag === "SetSnippetScope")?.args).toEqual({
      chatId: "chat-1",
      refId: "s1",
      global: true
    })
    expect(workspace.snapshot().items[0]!.global).toBe(true)
  })
})
