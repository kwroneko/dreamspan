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
      // A reopened edit reads its resting draft first: its history outlives saves (owner, 2026-11-02).
      expect(calls).toEqual(kind === "summary" ? ["GetSummaryDraft", "GetSummaryDraft"] : ["GetMessageDraft"])
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
  expect(messageEditorTools.get("message.edit-history")).toBeDefined()
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
  expect(summaryEditorTools.get("summary.draft-history")).toBeDefined()
  expect(messageActions.get("message.amendments")?.dialog).toBeDefined()
  for (const dispose of disposers.reverse()) dispose()
  expect(messageEditorTools.get("message.edit-history")).toBeUndefined()
  expect(summaryEditorTools.get("summary.draft-history")).toBeUndefined()
  expect(messageActions.get("message.amendments")).toBeUndefined()
  expect(messageTextEditor.get("message.code-editor")).toBeUndefined()
  expect(summaryTextEditor.get("summary.code-editor")).toBeUndefined()
  expect(summaryEditorTools.get("summary.current-changes")).toBeUndefined()
})

it("persists image-only editor changes with browser recovery and preserves images changed during a save", async () => {
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = []
  let answer: ((value: Draft) => void) | undefined
  const rpc = (tag: string, payload: Record<string, unknown>) => {
    if (tag === "GetMessageDraft") return Effect.succeed(null)
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
  const rpc = (tag: string, payload: Record<string, unknown>) =>
    tag === "GetMessageDraft"
      ? Effect.succeed(null)
      : Effect.succeed(new Draft({ ...draft(String(payload.content)), images: payload.images as [] }))
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

for (const kind of ["message", "summary"] as const)
  it(`${kind}: text typed during our Cancel is saved on its acknowledged deletion`, async () => {
    let release: ((value: Draft) => void) | undefined
    const calls: Array<{ tag: string; payload: Record<string, unknown> }> = []
    const rpc = (tag: string, payload: Record<string, unknown>) => {
      calls.push({ tag, payload })
      if (tag.startsWith("Get")) return Effect.succeed(draft("before cancel"))
      if (tag.startsWith("Discard"))
        return Effect.promise(
          () =>
            new Promise<Draft>((resolve) => {
              release = resolve
            })
        )
      return Effect.succeed(draft(String(payload.content), 6))
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
      kind === "summary"
        ? new SummaryDraft(session, "user", {
            id: "summary",
            revisionId: "revision",
            content: "saved",
            rowVersion: 1
          } as LcmSummary)
        : new MessageDraft(session, "user", targetFor("write"), "before cancel", draft("before cancel"))
    if (store instanceof SummaryDraft) await store.open()
    const cancelled = store.discard()
    await vi.waitFor(() => expect(release).toBeDefined())
    store.setText("typed after clicking Cancel")
    release!(new Draft({ ...draft("saved", 5), status: "discarded", session: 2, clearedVersion: 5 }))
    expect((await cancelled).ok).toBe(false)
    await store.save()
    expect(calls.at(-1)?.payload).toMatchObject({
      content: "typed after clicking Cancel",
      expectedRowVersion: 1,
      expectedSession: 1,
      observedDeletion: { draftId: "draft", rowVersion: 5 }
    })
    expect(store.snapshot().text).toBe("typed after clicking Cancel")
    if (store instanceof SummaryDraft) store.dispose()
  })

it("a newly opened blank editor saves new typing on its resting empty draft", async () => {
  let release: ((draft: Draft) => void) | undefined
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = []
  const resting = new Draft({ ...draft("", 5), status: "discarded", session: 2, clearedVersion: 5 })
  const rpc = (tag: string, payload: Record<string, unknown>) => {
    calls.push({ tag, payload })
    if (tag === "GetMessageDraft")
      return Effect.promise(
        () =>
          new Promise<Draft>((resolve) => {
            release = resolve
          })
      )
    return Effect.succeed(draft(String(payload.content), 6))
  }
  const session = {
    id: "chat",
    snapshot: () => ({ forkId: "fork" }),
    call: async (request: (client: typeof rpc) => Effect.Effect<unknown>) => ({
      ok: true,
      value: await Effect.runPromise(request(rpc))
    })
  } as unknown as ChatSession
  const store = new MessageDraft(session, "user", targetFor("write"), "", null)
  store.setText("fresh typing after reopening")
  const saving = store.save()
  await vi.waitFor(() => expect(release).toBeDefined())
  store.setText("fresh typing after reopening, final keystroke")
  release!(resting)
  await saving
  expect(calls.at(-1)?.payload).toMatchObject({
    content: "fresh typing after reopening, final keystroke",
    draftId: null,
    expectedRowVersion: null,
    expectedSession: null,
    observedDeletion: { draftId: "draft", rowVersion: 5 }
  })
  expect(store.snapshot().text).toBe("fresh typing after reopening, final keystroke")
  await store.save()
})

it("a first editor save creates its draft when the metadata read returns NotFound", async () => {
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = []
  const rpc = (tag: string, payload: Record<string, unknown>) => {
    calls.push({ tag, payload })
    return tag === "GetMessageDraft"
      ? Effect.fail(new Error("no draft yet"))
      : Effect.succeed(draft(String(payload.content)))
  }
  const session = {
    id: "chat",
    call: async (request: (client: typeof rpc) => Effect.Effect<unknown, unknown>) => {
      const result = await Effect.runPromiseExit(request(rpc))
      return result._tag === "Success"
        ? { ok: true, value: result.value }
        : { ok: false, error: { tag: "NotFound", message: "No draft yet", problems: [], reason: null } }
    }
  } as unknown as ChatSession
  const store = new MessageDraft(session, "user", targetFor("write"), "", null)
  store.setText("first text")
  await store.save()
  expect(calls.map((call) => call.tag)).toEqual(["GetMessageDraft", "SaveMessageDraft"])
  expect(store.snapshot().unsaved).toBe(false)
  expect(store.snapshot().text).toBe("first text")
})
