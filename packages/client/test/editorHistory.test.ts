import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { Draft, DraftHistoryPolicy, DraftKey } from "@rp/shared/drafts.ts"
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { LcmSummary } from "@rp/shared/lcm.ts"
import type { ChatSession } from "../src/features/chat/session.ts"
import { MessageDraft } from "../src/features/chat/messageDraft.ts"
import { SummaryDraft } from "../src/features/chat/summaryDraft.ts"

const draft = (content: string, rowVersion = 1) =>
  new Draft({
    id: "draft",
    key: new DraftKey({ targetKind: "version_edit", targetId: "version", field: "" }),
    content,
    rowVersion,
    session: 1,
    status: "active",
    baseRevision: "revision",
    createdAt: 0,
    updatedAt: 0,
    recovered: 0,
    displaced: null,
    historyLength: 3
  })

const targetFor = (kind: string) =>
  kind === "queue"
    ? { _tag: "Queue" as const, chatId: "chat" as ChatId, queuedId: "queue", rowVersion: 1 }
    : kind === "write"
      ? { _tag: "Write" as const, slotId: "slot" as SlotId }
      : { _tag: "Edit" as const, versionId: "version" as VersionId }

it("keeps a summary's original comparison and save base when another revision arrives before autosave", async () => {
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = []
  const rpc = (tag: string, payload: Record<string, unknown>) => {
    calls.push({ tag, payload })
    return Effect.succeed(tag === "GetSummaryDraft" ? null : draft(String(payload.content)))
  }
  const session = {
    snapshot: () => ({ forkId: "fork" }),
    call: async (request: (client: typeof rpc) => Effect.Effect<unknown>) => ({
      ok: true,
      value: await Effect.runPromise(request(rpc))
    })
  } as unknown as ChatSession
  const summary = { id: "summary", revisionId: "revision", content: "original", rowVersion: 1 } as LcmSummary
  const store = new SummaryDraft(session, "user", summary)
  await store.open()
  store.setText("typed from the original")
  store.update({ ...summary, revisionId: "new-revision" as LcmSummary["revisionId"], content: "elsewhere" })
  expect(store.comparisonRevisionId).toBe("revision")
  expect(store.snapshot().outdated).toBe(true)
  await store.save()
  expect(calls.at(-1)?.payload.baseRevisionId).toBe("revision")
  store.dispose()
})

for (const kind of ["message", "write", "queue", "summary"] as const)
  describe(`${kind} history`, () => {
    it("has no earlier text before the first draft is saved", async () => {
      const calls: string[] = []
      const rpc = (tag: string) => {
        calls.push(tag)
        return Effect.succeed(null)
      }
      const session = {
        snapshot: () => ({ forkId: "fork" }),
        call: async (request: (client: typeof rpc) => Effect.Effect<unknown>) => ({
          ok: true,
          value: await Effect.runPromise(request(rpc))
        })
      } as unknown as ChatSession
      const store =
        kind !== "summary"
          ? new MessageDraft(session, "user", targetFor(kind), "saved", null)
          : new SummaryDraft(session, "user", {
              id: "summary",
              revisionId: "revision",
              content: "saved",
              rowVersion: 1
            } as LcmSummary)
      if (store instanceof SummaryDraft) await store.open()
      expect(await store.history()).toEqual({ ok: true, value: [] })
      expect(calls).toEqual(kind === "summary" ? ["GetSummaryDraft"] : [])
    })

    it("loads the complete retained history and preserves typing while restore is in flight", async () => {
      const calls: Array<{ tag: string; payload: Record<string, unknown> }> = []
      let answer: ((value: Draft) => void) | undefined
      const rpc = (tag: string, payload: Record<string, unknown>) => {
        calls.push({ tag, payload })
        if (tag.startsWith("Get")) return Effect.succeed(draft("current"))
        if (tag.endsWith("History")) return Effect.succeed([])
        if (tag.startsWith("Restore"))
          return Effect.promise(
            () =>
              new Promise<Draft>((resolve) => {
                answer = resolve
              })
          )
        return Effect.succeed(draft(String(payload.content), 3))
      }
      const session = {
        id: "chat",
        snapshot: () => ({ forkId: "fork" }),
        call: async (request: (client: typeof rpc) => Effect.Effect<unknown>) => ({
          ok: true,
          value: await Effect.runPromise(request(rpc))
        })
      } as unknown as ChatSession
      const store =
        kind !== "summary"
          ? new MessageDraft(session, "user", targetFor(kind), "current", draft("current"))
          : new SummaryDraft(session, "user", {
              id: "summary",
              revisionId: "revision",
              content: "saved",
              rowVersion: 1
            } as LcmSummary)
      if (store instanceof SummaryDraft) await store.open()
      await store.history()
      expect(calls.at(-1)?.payload.limit).toBe(DraftHistoryPolicy.maxEntries + 1)
      const restore = store.restoreState(1)
      await vi.waitFor(() => expect(answer).toBeDefined())
      store.setText("typed while restoring")
      answer!(draft("earlier", 2))
      expect(await restore).toBe(true)
      expect(store.snapshot().text).toBe("typed while restoring")
      expect(store.snapshot().unsaved).toBe(true)
      await store.save()
      expect(calls.at(-1)?.payload).toMatchObject({ content: "typed while restoring", expectedRowVersion: 2 })
      expect(store.snapshot().text).toBe("typed while restoring")
      expect(store.snapshot().unsaved).toBe(false)
    })
  })

it("editor history and saved amendments are removable registered contributions", async () => {
  const { registerEditorHistory, messageEditorTools, summaryEditorTools, messageTextEditor, summaryTextEditor } =
    await import("../src/features/chat/editorHistory.tsx")
  const { messageActions } = await import("../src/features/chat/messageActions.tsx")
  const disposers = registerEditorHistory()
  expect(messageTextEditor.get("message.code-editor")).toBeDefined()
  expect(summaryTextEditor.get("summary.code-editor")).toBeDefined()
  expect(messageEditorTools.get("message.current-changes")).toBeDefined()
  expect(summaryEditorTools.get("summary.current-changes")).toBeDefined()
  const original = messageTextEditor.get("message.code-editor")!
  const alternative = () => null
  const replace = messageTextEditor.register({ ...original, component: alternative })
  expect(messageTextEditor.get(original.id)?.component).toBe(alternative)
  const disable = messageTextEditor.disable(original.id)
  expect(messageTextEditor.get(original.id)).toBeUndefined()
  disable()
  replace()
  expect(messageTextEditor.get(original.id)).toBe(original)
  expect(messageEditorTools.get("message.draft-history")).toBeDefined()
  expect(summaryEditorTools.get("summary.draft-history")).toBeDefined()
  expect(messageActions.get("message.amendments")?.dialog).toBeDefined()
  for (const dispose of disposers.reverse()) dispose()
  expect(messageEditorTools.get("message.draft-history")).toBeUndefined()
  expect(summaryEditorTools.get("summary.draft-history")).toBeUndefined()
  expect(messageActions.get("message.amendments")).toBeUndefined()
  expect(messageTextEditor.get("message.code-editor")).toBeUndefined()
  expect(summaryTextEditor.get("summary.code-editor")).toBeUndefined()
  expect(messageEditorTools.get("message.current-changes")).toBeUndefined()
  expect(summaryEditorTools.get("summary.current-changes")).toBeUndefined()
})

it("persists image-only editor changes with browser recovery and preserves images changed during a save", async () => {
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = []
  let answer: ((value: Draft) => void) | undefined
  const rpc = (tag: string, payload: Record<string, unknown>) => {
    calls.push({ tag, payload })
    return Effect.promise(
      () =>
        new Promise<Draft>((resolve) => {
          answer = resolve
        })
    )
  }
  const session = {
    id: "image-draft-chat",
    call: async (request: (client: typeof rpc) => Effect.Effect<unknown>) => ({
      ok: true,
      value: await Effect.runPromise(request(rpc))
    })
  } as unknown as ChatSession
  const store = new MessageDraft(session, "user", targetFor("message"), "same text", null)
  const first = [{ mediaId: "first" }]
  const second = [{ mediaId: "second" }]
  store.setImages(first)
  const save = store.save()
  await vi.waitFor(() => expect(answer).toBeDefined())
  expect(calls[0]!.payload).toMatchObject({ content: "same text", images: first })
  store.setImages(second)
  answer!(new Draft({ ...draft("same text"), images: first }))
  await save
  expect(store.snapshot().unsaved).toBe(true)
  expect(store.snapshot().images).toEqual(second)
  const next = store.save()
  await vi.waitFor(() => expect(calls).toHaveLength(2))
  answer!(new Draft({ ...draft("same text", 2), images: second }))
  await next
  const submitted = await store.ready()
  expect(submitted.images).toEqual(second)
  store.setImages([])
  expect(store.committed(submitted)).toBe(false)
  // A fresh editor reads the persisted images, including an explicit empty set.
  const reopened = new MessageDraft(
    session,
    "user",
    targetFor("message"),
    "source",
    new Draft({ ...draft("same text"), images: [] })
  )
  expect(reopened.snapshot().images).toEqual([])
  // Finish the last pending save so no timer is left behind.
  const last = store.save()
  await vi.waitFor(() => expect(calls).toHaveLength(3))
  answer!(new Draft({ ...draft("same text", 3), images: [] }))
  await last
})

it("waits for an editor image upload before taking the image set to save", async () => {
  const rpc = (_tag: string, payload: Record<string, unknown>) =>
    Effect.succeed(new Draft({ ...draft(String(payload.content)), images: payload.images as [] }))
  const session = {
    id: "upload-draft-chat",
    call: async (request: (client: typeof rpc) => Effect.Effect<unknown>) => ({
      ok: true,
      value: await Effect.runPromise(request(rpc))
    })
  } as unknown as ChatSession
  const store = new MessageDraft(session, "user", targetFor("message"), "study", null)
  let finish!: () => void
  const uploading = store.uploadImages(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    store.setImages([{ mediaId: "uploaded" }])
  })
  const ready = store.ready()
  expect(store.snapshot().imagesBusy).toBe(true)
  await vi.waitFor(() => expect(finish).toBeDefined())
  finish()
  await uploading
  expect((await ready).images).toEqual([{ mediaId: "uploaded" }])
  expect(store.snapshot().imagesBusy).toBe(false)
})
