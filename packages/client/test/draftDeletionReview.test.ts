import type { ChatId, ForkId, VersionId } from "@dreamspan/shared/chat.ts"
import type { LcmSummary } from "@dreamspan/shared/lcm.ts"
import type { ChatSession } from "../src/features/chat/session.ts"
import type { Caller } from "../src/features/editor/caller.ts"
import type { Copy } from "../src/features/editor/backup.ts"
import { Effect, Exit } from "effect"
import { it, expect, vi, beforeEach } from "vitest"
import { valueField } from "@dreamspan/shared/editing.ts"
import { Draft, DraftKey } from "@dreamspan/shared/drafts.ts"
import { makeCopy } from "../src/features/editor/backup.ts"
vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "localhost" }))
const copies = vi.hoisted(() => new Map<string, Copy>())
vi.mock("../src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/backup.ts")>()),
  copiesOf: async () => [...copies.values()],
  copiesOfUser: async () => [...copies.values()],
  keepCopy: async (c: Copy, p?: Copy | null) => {
    copies.set(c.key, c)
    if (p) copies.delete(p.key)
  },
  dropCopy: async (c: Copy) => {
    copies.delete(c.key)
  }
}))
import { MessageDraft } from "../src/features/chat/messageDraft.ts"
import { SummaryDraft } from "../src/features/chat/summaryDraft.ts"
import { ComposerDraft } from "../src/features/chat/composerDraft.ts"
import { EditorStore } from "../src/features/editor/store.ts"
const tombstone = new Draft({
  id: "draft",
  key: new DraftKey({ targetKind: "version_edit", targetId: "version", field: "" }),
  content: "saved",
  status: "discarded",
  rowVersion: 5,
  clearedVersion: 5,
  session: 2,
  baseRevision: "revision",
  createdAt: 1,
  updatedAt: 5,
  historyLength: 3,
  recovered: 0,
  displaced: null
})
const target = { _tag: "Edit", versionId: "version" as VersionId } as const
const summary = { id: "summary", revisionId: "revision", content: "saved", rowVersion: 1 } as LcmSummary
type Rpc = (tag: string, payload: Record<string, unknown>) => Effect.Effect<unknown, string>
const session = (read: Draft | null = tombstone, rpc?: Rpc): ChatSession =>
  ({
    id: "chat" as ChatId,
    snapshot: () => ({ forkId: "fork" }),
    call: async (fn: (client: Rpc) => Effect.Effect<unknown, unknown>) => {
      const result = await Effect.runPromiseExit(
        fn(
          rpc ??
            ((tag: string) =>
              tag.startsWith("Get") || tag === "OpenComposer"
                ? Effect.succeed(read)
                : Effect.fail("offline during replay"))
        )
      )
      return Exit.isSuccess(result)
        ? { ok: true, value: result.value }
        : { ok: false, error: { tag: "ServerError", message: "offline", problems: [], reason: null } }
    }
  }) as unknown as ChatSession
beforeEach(() => copies.clear())
it.each(["message", "resting message", "insertion", "summary"] as const)(
  "known deletion must block %s stale browser text when replay fails",
  async (kind) => {
    const save =
      kind !== "summary"
        ? {
            kind: "message" as const,
            payload: {
              target:
                kind === "insertion"
                  ? { _tag: "Insert" as const, chatId: "chat" as ChatId, forkId: "fork" as ForkId, anchor: null }
                  : target,
              draftId: "draft",
              content: "deleted offline text",
              expectedRowVersion: 1,
              expectedSession: 1
            }
          }
        : {
            kind,
            payload: {
              summaryId: summary.id,
              forkId: "fork" as ForkId,
              draftId: "draft",
              content: "deleted offline text",
              expectedRowVersion: 1,
              expectedSession: 1,
              baseRevisionId: summary.revisionId
            }
          }
    const c = makeCopy("user", kind !== "summary" ? "messages:chat" : "summary:fork", kind, save, 1)
    copies.set(c.key, c)
    const store =
      kind !== "summary"
        ? new MessageDraft(
            session(),
            "user",
            save.kind === "message" ? save.payload.target : target,
            "saved",
            kind === "message" ? tombstone : null
          )
        : new SummaryDraft(session(), "user", summary)
    if (store instanceof MessageDraft) await store.restore([c])
    else await store.open()
    expect(copies.has(c.key)).toBe(true)
    expect(store.snapshot().text).toBe("saved")
  }
)
it("known deletion must block a composer stale copy when replay fails", async () => {
  const t = new Draft({
    ...tombstone,
    key: new DraftKey({ targetKind: "composer", targetId: "chat", field: "fork" }),
    status: "active",
    content: ""
  })
  const c = makeCopy(
    "user",
    "composer:chat",
    "draft",
    {
      kind: "composer",
      payload: {
        chatId: "chat" as ChatId,
        draftId: "draft",
        rowVersion: 1,
        session: 1,
        next: false,
        content: "deleted composer text"
      }
    },
    1
  )
  copies.set(c.key, c)
  const store = new ComposerDraft(session(t), "user", {
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 100000,
    keepalive: async () => false
  })
  store.setFork("fork" as ForkId, false)
  await vi.waitFor(() => expect(store.snapshot().ready).toBe(true))
  expect(store.snapshot().text).toBe("")
})
it.each([
  { online: false, content: "" },
  { online: true, content: "" },
  { online: false, content: "deleted composer text" },
  { online: true, content: "deleted composer text" }
])(
  "a composer deletion copy is acknowledged only after a successful replay (online: $online, text: '$content')",
  async ({ online, content }) => {
    const current = new Draft({
      ...tombstone,
      key: new DraftKey({ targetKind: "composer", targetId: "chat", field: "fork" }),
      status: "active",
      content: ""
    })
    const copy = makeCopy(
      "user",
      "composer:chat",
      "draft",
      {
        kind: "composer",
        payload: {
          chatId: "chat" as ChatId,
          draftId: "draft",
          rowVersion: 1,
          session: 1,
          next: false,
          content
        }
      },
      1
    )
    copies.set(copy.key, copy)
    const replayed: Array<unknown> = []
    const store = new ComposerDraft(
      session(current, (tag, payload) => {
        if (tag === "OpenComposer") return Effect.succeed(current)
        replayed.push(payload)
        return online ? Effect.succeed({ draft: current, recovered: false }) : Effect.fail("offline")
      }),
      "user",
      {
        setTimer: () => 0,
        clearTimer: () => {},
        now: () => 100000,
        keepalive: async () => false
      }
    )
    store.setFork("fork" as ForkId, false)
    await vi.waitFor(() => expect(store.snapshot().ready).toBe(true))
    expect(replayed).toEqual([copy.save.payload])
    expect(store.snapshot().text).toBe("")
    expect(copies.has(copy.key)).toBe(!online)
  }
)

it("edited marker clears when typing returns to last saved revision", async () => {
  const snap = {
    ref: { id: "ref", kind: "card", headRevisionId: "rev", label: "card" },
    doc: { description: "saved", options: { a: 1, b: 2 } },
    drafts: []
  }
  const key = JSON.stringify(["description"])
  let stored: Draft | null = null
  const rpc = (tag: string, p: Record<string, unknown>) => {
    if (tag === "SaveEditorDraft" || tag === "RestoreEditorDraft") {
      stored = new Draft({
        ...tombstone,
        key: new DraftKey({ targetKind: "entity_field", targetId: "ref", field: key }),
        clearedVersion: 0,
        content: String(p.content),
        status: "active",
        rowVersion: 6
      })
      return Effect.succeed(stored)
    }
    return Effect.succeed({ ...snap, drafts: stored === null ? [] : [stored] })
  }
  const store = new EditorStore(
    "ref" as never,
    "user",
    (async (fn: (client: typeof rpc) => Effect.Effect<unknown>) => ({
      ok: true,
      value: await Effect.runPromise(fn(rpc))
    })) as unknown as Caller,
    { setTimer: () => 0, clearTimer: () => {}, now: () => 1, keepalive: async () => false }
  )
  await store.load()
  store.setText(["description"], "changed")
  expect(store.isDirty(JSON.stringify(["description"]))).toBe(true)
  store.setText(["description"], "saved")
  expect(store.text(["description"])).toBe("saved")
  expect(store.isDirty(JSON.stringify(["description"]))).toBe(false)
  await store.flush()
  expect(store.isDirty(key)).toBe(false)
  expect(store.hasHistory(key)).toBe(true)
  await store.load()
  expect(store.isDirty(key)).toBe(false)
  store.setText(["description"], "another change")
  expect(store.isDirty(key)).toBe(true)
  await store.restore(key, 0, "saved")
  expect(store.text(["description"])).toBe("saved")
  expect(store.isDirty(key)).toBe(false)
  expect(store.hasHistory(key)).toBe(true)
  store.setValue(["options"], { b: 2, a: 1 })
  expect(store.isDirty(valueField(["options"]))).toBe(false)
  store.setValue(["absent"], undefined)
  expect(store.isDirty(valueField(["absent"]))).toBe(false)
})

it.each(["legacy", "stale", "fresh"] as const)(
  "a %s first-send handoff respects the destination deletion",
  async (kind) => {
    const t = new Draft({
      ...tombstone,
      key: new DraftKey({ targetKind: "composer", targetId: "chat", field: "fork" }),
      status: "active",
      content: ""
    })
    const c = makeCopy(
      "user",
      "pending-chat:card",
      "first message",
      {
        kind: "pendingChat",
        payload: {
          entityId: "card",
          name: "Synthetic",
          chatId: "chat" as ChatId,
          content: "first-send handoff",
          ...(kind === "legacy"
            ? {}
            : { composerBase: { draftId: "draft", rowVersion: kind === "fresh" ? 5 : 1, session: 2 } })
        }
      },
      1
    )
    copies.set(c.key, c)
    let sent: Record<string, unknown> | undefined
    const transport = session(t, (tag, p) => {
      if (tag === "OpenComposer") return Effect.succeed(t)
      sent = p
      return Effect.succeed({ draft: new Draft({ ...t, content: String(p.content), rowVersion: 6 }), recovered: false })
    })
    const store = new ComposerDraft(transport, "user", {
      setTimer: () => 0,
      clearTimer: () => {},
      now: () => 100000,
      keepalive: async () => false
    })
    store.setFork("fork" as ForkId, false)
    await vi.waitFor(() => expect(store.snapshot().ready).toBe(true))
    if (kind === "fresh") {
      expect(sent).toMatchObject({ rowVersion: 5, content: "first-send handoff" })
      expect(store.snapshot().text).toBe("first-send handoff")
    } else {
      expect(sent).toBeUndefined()
      expect(store.snapshot().text).toBe("")
      expect(copies.has(c.key)).toBe(true)
    }
  }
)

it.each(["message", "summary"] as const)(
  "fresh %s copy after an older deletion survives replay failure",
  async (kind) => {
    const c = makeCopy(
      "user",
      kind === "message" ? "messages:chat" : "summary:fork",
      kind,
      kind === "message"
        ? {
            kind,
            payload: {
              target,
              draftId: "draft",
              content: "fresh last keystroke",
              expectedRowVersion: 5,
              expectedSession: 2
            }
          }
        : {
            kind,
            payload: {
              summaryId: summary.id,
              forkId: "fork" as ForkId,
              baseRevisionId: summary.revisionId,
              draftId: "draft",
              content: "fresh last keystroke",
              expectedRowVersion: 5,
              expectedSession: 2
            }
          },
      1
    )
    copies.set(c.key, c)
    const store =
      kind === "message"
        ? new MessageDraft(session(), "user", target, "saved", null)
        : new SummaryDraft(session(), "user", summary)
    if (store instanceof MessageDraft) await store.restore([c])
    else await store.open()
    expect(store.snapshot().text).toBe("fresh last keystroke")
    expect(copies.has(c.key)).toBe(true)
  }
)

it("message recovery cannot overwrite typing during its resting-draft read", async () => {
  let release!: () => void
  const read = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = session(null, (tag) =>
    tag === "GetMessageDraft"
      ? Effect.promise(async () => {
          await read
          return tombstone
        })
      : Effect.fail("offline")
  )
  const c = makeCopy(
    "user",
    "messages:chat",
    "edit:version",
    {
      kind: "message",
      payload: { target, draftId: "draft", content: "old copy", expectedRowVersion: 5, expectedSession: 2 }
    },
    1
  )
  copies.set(c.key, c)
  const store = new MessageDraft(transport, "user", target, "saved", null)
  const opening = store.restore([c])
  await Promise.resolve()
  store.setText("typed before close")
  release()
  await opening
  expect(store.snapshot().text).toBe("typed before close")
  expect([...copies.values()].some((copy) => copy.content === "typed before close")).toBe(true)
  await store.save()
})

it("a fresh insertion loads its post-Cancel base before its first durable key and reloads in place", async () => {
  vi.useFakeTimers()
  try {
    const resting = new Draft({
      ...tombstone,
      key: new DraftKey({ targetKind: "insert", targetId: "chat", field: "fork:" }),
      content: ""
    })
    const target = { _tag: "Insert" as const, chatId: "chat" as ChatId, forkId: "fork" as ForkId, anchor: null }
    let fail = true
    const transport = session(resting, (tag) =>
      tag === "GetMessageDraft"
        ? fail
          ? Effect.fail("interrupted open")
          : Effect.succeed(resting)
        : Effect.fail("interrupted save")
    )
    const first = new MessageDraft(transport, "user", target, "", null)
    expect(first.snapshot().loading).toBe(true)
    await first.open()
    expect(first.snapshot().loading).toBe(true)
    fail = false
    await first.open()
    expect(first.snapshot().loading).toBe(false)
    first.setText("fresh final keystroke after reopening")
    const kept = [...copies.values()]
    expect(kept).toHaveLength(1)
    expect(kept[0]?.save).toMatchObject({
      kind: "message",
      payload: { draftId: resting.id, expectedRowVersion: resting.rowVersion, expectedSession: resting.session }
    })
    const reopened = new MessageDraft(transport, "user", target, "", null)
    await reopened.restore(kept)
    expect(reopened.snapshot().text).toBe("fresh final keystroke after reopening")
    expect(reopened.snapshot().loading).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it("a known post-Cancel copy is visible while its replay save is still pending", async () => {
  const resting = new Draft({
    ...tombstone,
    key: new DraftKey({ targetKind: "insert", targetId: "chat", field: "fork:" }),
    content: ""
  })
  const target = { _tag: "Insert" as const, chatId: "chat" as ChatId, forkId: "fork" as ForkId, anchor: null }
  const fresh = "fresh before autosave"
  const copy = makeCopy(
    "user",
    "messages:chat",
    "insert:fork:",
    {
      kind: "message",
      payload: {
        target,
        draftId: resting.id,
        expectedRowVersion: resting.rowVersion,
        expectedSession: resting.session,
        content: fresh
      }
    },
    1
  )
  copies.set(copy.key, copy)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = session(resting, (tag) =>
    tag === "GetMessageDraft"
      ? Effect.succeed(resting)
      : Effect.promise(async () => {
          await pending
          return new Draft({ ...resting, status: "active", content: fresh, rowVersion: 6 })
        })
  )
  const reopened = new MessageDraft(transport, "user", target, "", null)
  const restoring = reopened.restore([copy])
  try {
    await vi.waitFor(() => expect(reopened.snapshot().text).toBe(fresh))
  } finally {
    release()
    await restoring
  }
  expect(reopened.snapshot().unsaved).toBe(false)
})

it("a fresh editor can be closed while its opening read is pending", async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = session(null, () =>
    Effect.promise(async () => {
      await pending
      return tombstone
    })
  )
  const editor = new MessageDraft(transport, "user", target, "", null)
  const opening = editor.open()
  let closed = false
  const closing = editor.discard().then((result) => {
    closed = result.ok
  })
  try {
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 })
  } finally {
    release()
    await opening
    await closing
  }
  expect(copies.size).toBe(0)
})

it("an exact replay compares image values while preserving the later attachment copy", async () => {
  const active = new Draft({ ...tombstone, status: "active", clearedVersion: 0 })
  const image = { altText: "Synthetic caption", mediaId: "synthetic-media" }
  const copy = makeCopy(
    "user",
    "messages:chat",
    "edit:version",
    {
      kind: "message",
      payload: {
        target,
        draftId: active.id,
        content: "",
        images: [image],
        expectedRowVersion: active.rowVersion,
        expectedSession: active.session
      }
    },
    1
  )
  copies.set(copy.key, copy)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const acknowledged = new Draft({
    ...active,
    content: "",
    rowVersion: 6,
    clearedVersion: 6,
    images: [{ mediaId: image.mediaId, altText: image.altText }]
  })
  const store = new MessageDraft(
    session(active, () =>
      Effect.promise(async () => {
        await held
        return acknowledged
      })
    ),
    "user",
    target,
    "",
    active
  )
  const restoring = store.restore([copy])
  try {
    await vi.waitFor(() => expect(store.snapshot().text).toBe(""))
    store.setText("new text on the recovered empty field")
  } finally {
    release()
    await restoring
  }
  const fresh = [...copies.values()].find((kept) => kept.content !== "")
  expect(fresh?.save).toMatchObject({ kind: "message", payload: { expectedRowVersion: 6, images: [image] } })
  store.committed({ text: store.snapshot().text, images: store.snapshot().images, draft: null })
})
