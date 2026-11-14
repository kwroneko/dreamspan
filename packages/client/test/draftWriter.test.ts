import { describe, expect, it } from "vitest"
import { Effect, Exit, Stream } from "effect"
import { DraftWriter, draftSeparator } from "../src/features/chat/draftWriter.ts"
import type { ChatSession } from "../src/features/chat/session.ts"
import type { ComposerDraft } from "../src/features/chat/composerDraft.ts"

const setup = () => {
  const draftListeners = new Set<() => void>()
  const viewListeners = new Set<() => void>()
  const draft = { text: "  My text \n", ready: true, draftId: "draft-a" }
  const view = { forkId: "fork-a", leafSlotId: "leaf-a", loading: false }
  const calls: string[] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const session = {
    id: "chat-a",
    snapshot: () => view,
    subscribe: (listener: () => void) => {
      viewListeners.add(listener)
      return () => viewListeners.delete(listener)
    },
    call: async (run: (api: unknown) => Effect.Effect<unknown, unknown>) => {
      const exit = await Effect.runPromiseExit(
        run((tag: string) => {
          calls.push(tag)
          if (tag === "GetLastDraftRollout") return Effect.succeed(null)
          return Stream.concat(
            Stream.make({ rolloutId: "request-a", text: "First." }),
            Stream.fromEffect(Effect.promise(() => gate)).pipe(
              Stream.map(() => ({ rolloutId: "request-a", text: "Late." }))
            )
          )
        })
      )
      return Exit.isSuccess(exit)
        ? { ok: true, value: exit.value }
        : { ok: false, error: { message: "Provider failed" } }
    }
  }
  const source = {
    snapshot: () => draft,
    subscribe: (listener: () => void) => {
      draftListeners.add(listener)
      return () => draftListeners.delete(listener)
    },
    type: (text: string) => {
      draft.text = text
      for (const listener of draftListeners) listener()
    },
    flush: async () => {}
  }
  return {
    draft,
    view,
    source,
    calls,
    release,
    switchView: () => {
      for (const listener of viewListeners) listener()
    },
    writer: new DraftWriter(session as unknown as ChatSession, source as unknown as ComposerDraft)
  }
}

describe("Write for me draft destination", () => {
  it("leaves idle composer work unchanged", () => {
    const f = setup()
    const before = f.writer.snapshot()
    f.writer.stop()
    expect(f.writer.snapshot()).toBe(before)
    expect(f.calls).toEqual([])
  })
  it("separates paragraphs without changing existing bytes", () => {
    expect(draftSeparator("")).toBe("")
    expect(draftSeparator("Text")).toBe("\n\n")
    expect(draftSeparator("Text \n")).toBe("\n")
    expect(draftSeparator("Text\n\n")).toBe("")
  })
  it("Stop keeps the append and one Undo restores the exact original text", async () => {
    const f = setup()
    const running = f.writer.start()
    await expect.poll(() => f.draft.text).toBe("  My text \n\nFirst.")
    f.writer.stop()
    f.release()
    await running
    expect(f.draft.text).toBe("  My text \n\nFirst.")
    f.writer.undo()
    expect(f.draft.text).toBe("  My text \n")
    expect(f.calls).toEqual(["WriteForMe"])
  })
  it("switching branch ignores every late chunk and Undo cannot touch the new draft", async () => {
    const f = setup()
    const running = f.writer.start()
    await expect.poll(() => f.writer.snapshot().rolloutId).toBe("request-a")
    f.view.forkId = "fork-b"
    f.draft.draftId = "draft-b"
    f.draft.text = "Other branch"
    f.switchView()
    f.release()
    await running
    f.writer.undo()
    expect(f.draft.text).toBe("Other branch")
    expect(f.writer.snapshot().running).toBe(false)
  })
  it("a send clears the draft and stops the stream before later output arrives", async () => {
    const f = setup()
    const running = f.writer.start()
    await expect.poll(() => f.writer.snapshot().rolloutId).toBe("request-a")
    f.source.type("")
    f.release()
    await running
    expect(f.draft.text).toBe("")
    expect(f.writer.snapshot().running).toBe(false)
  })
})
