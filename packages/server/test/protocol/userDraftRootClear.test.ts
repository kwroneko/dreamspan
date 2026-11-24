import { assert, it } from "@effect/vitest"
import { editingOrigin } from "@dreamspan/shared/draftDeletions.ts"
import { Effect, Exit } from "effect"
import { vi } from "vitest"
import type { Copy } from "../../../client/src/features/editor/backup.ts"
import { makeCopy, pendingOf } from "../../../client/src/features/editor/backup.ts"
import { readTypedBackup } from "../../../client/src/features/editor/typedBackup.ts"
import { UserDraftStore } from "../../../client/src/features/editor/userDraft.tsx"
import { Generator } from "../../src/chat/Generator.ts"
import { client, post, serverLayer, testConfig } from "../support/config.ts"

const browser = vi.hoisted(() => {
  const memory = new Map<string, Copy>(),
    storage = new Map<string, string>()
  const state = { memory, storage, closed: false }
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" })
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (!state.closed) storage.set(key, value)
    },
    removeItem: (key: string) => {
      if (!state.closed) storage.delete(key)
    }
  })
  return state
})
vi.mock("../../../client/src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../../../client/src/features/editor/backup.ts")>()),
  keepCopy: async (copy: Copy, previous?: Copy | null) => {
    if (browser.closed) return
    browser.memory.set(copy.key, copy)
    if (previous) browser.memory.delete(previous.key)
  },
  dropCopy: async (copy: Copy) => {
    if (!browser.closed) browser.memory.delete(copy.key)
  },
  copiesOf: async () => [...browser.memory.values()]
}))

type Api = Effect.Success<ReturnType<typeof client>>
type Run = ConstructorParameters<typeof UserDraftStore>[3]
const runWith =
  (api: Api, intercept?: (tag: keyof Api) => Effect.Effect<unknown, unknown> | undefined): Run =>
  async (use) => {
    const rpc = (tag: keyof Api, payload: never) => intercept?.(tag) ?? api[tag](payload)
    const outcome = await Effect.runPromiseExit(use(rpc as Parameters<typeof use>[0]))
    return Exit.isSuccess(outcome)
      ? { ok: true, value: outcome.value }
      : {
          ok: false,
          error: { tag: "ServerError", message: "Synthetic closed page", problems: [], reason: null }
        }
  }
const reset = () => {
  browser.memory.clear()
  browser.storage.clear()
  browser.closed = false
}

// A new workshop's first message is a user draft with a typed backup. The old new-chat page's
// `pending-chat:<card>` key no longer keeps one: its saves go to recovered texts (f543b0e9d).
for (const [targetId, field] of [
  ["pending-workshop:synthetic-root", "First message"],
  ["Settings → Chats", "Summarization instruction"]
] as const)
  for (const delivery of ["rpc", "reload", "keepalive"] as const)
    it.live(`a blocked ${field} clear survives replacement of its empty copy through ${delivery}`, () =>
      Effect.gen(function* () {
        reset()
        const api = yield* client(),
          ownerId = (yield* api.Whoami()).id
        const address = { ownerId, targetId, field }
        const old = "Text deliberately cleared on device B",
          fresh = "Fresh text typed after clearing"
        const first = yield* api.SaveUserDraft({
          ...address,
          content: old,
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null
        })
        let release!: () => void,
          reading = false,
          closed = false,
          refused = 0
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        const store = new UserDraftStore(
          ownerId,
          targetId,
          field,
          runWith(api, (tag) => {
            if (tag === "UserDraftHistory")
              return Effect.promise(async () => {
                reading = true
                await held
                return []
              })
            if (closed) {
              if (tag === "SaveUserDraft") refused++
              return Effect.fail("old page closed")
            }
          })
        )
        store.open()
        yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(store.snapshot().ready)))
        store.history()
        yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(reading)))
        let copy!: Copy
        try {
          store.type("", old)
          store.type(fresh, old)
          assert.strictEqual(browser.memory.size, 1, "only the final durable copy survives close")
          copy = [...browser.memory.values()][0]!
          assert.strictEqual(copy.content, fresh)
          if (field === "First message") assert.deepStrictEqual(readTypedBackup(ownerId, targetId), copy)
        } finally {
          closed = true
          browser.closed = true
          release()
          yield* Effect.promise(() => vi.waitFor(() => assert.strictEqual(refused, 2)))
        }
        // Decode exactly the surviving copy, as browser recovery and the keepalive parser do.
        const save = pendingOf(JSON.parse(JSON.stringify(copy)))
        assert.strictEqual(save?.kind, "userDraft")
        if (save?.kind !== "userDraft") return
        if (delivery === "rpc") yield* api.SaveUserDraft(save.payload)
        else if (delivery === "keepalive") {
          const response = yield* post("/library/drafts", { drafts: [], userDrafts: [save.payload] })
          assert.strictEqual(response.status, 204)
        } else {
          browser.closed = false
          const reopened = new UserDraftStore(ownerId, targetId, field, runWith(api))
          reopened.open()
          yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(reopened.snapshot().ready)))
          assert.strictEqual(reopened.snapshot().text, fresh)
        }
        const received = (yield* api.GetUserDraft(address))!
        assert.strictEqual(received.content, fresh)
        const late = yield* api.SaveUserDraft({
          ...address,
          content: old,
          draftId: first.id,
          expectedRowVersion: first.rowVersion,
          expectedSession: first.session,
          editingFrom: old
        })
        assert.strictEqual(late.content, fresh, "the other device's pre-clear text stays deleted")
        assert.isAbove(received.clearedVersion!, 0)
        assert.isAbove(late.recovered, 0)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
    )

it.live("a direct replacement without a clear cannot manufacture a whole-field barrier", () =>
  Effect.gen(function* () {
    reset()
    const api = yield* client(),
      ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "replacement-control", field: "Instruction" }
    const old = "Original text",
      fresh = "Direct replacement"
    const first = yield* api.SaveUserDraft({
      ...address,
      content: old,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null
    })
    const store = new UserDraftStore(ownerId, address.targetId, address.field, runWith(api))
    store.open()
    yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(store.snapshot().ready)))
    store.type(fresh, old)
    yield* Effect.promise(() => vi.waitFor(() => assert.strictEqual(browser.memory.size, 0)))
    const saved = (yield* api.GetUserDraft(address))!
    assert.strictEqual(saved.content, fresh)
    assert.strictEqual(saved.clearedVersion, 0)
    assert.isUndefined(saved.deletions?.[""])
    const late = yield* api.SaveUserDraft({
      ...address,
      content: old,
      draftId: first.id,
      expectedRowVersion: first.rowVersion,
      expectedSession: first.session,
      editingFrom: old
    })
    assert.strictEqual(late.content, old)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("acknowledging a whole-field clear retires its intent before another device types", () =>
  Effect.gen(function* () {
    reset()
    const api = yield* client(),
      ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "retired-root-clear", field: "Instruction" }
    const original = "Actual clear",
      remote = "Other device's fresh typing"
    yield* api.SaveUserDraft({
      ...address,
      content: original,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null
    })
    const store = new UserDraftStore(ownerId, address.targetId, address.field, runWith(api))
    store.open()
    yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(store.snapshot().ready)))
    store.type("", original)
    yield* Effect.promise(() => vi.waitFor(() => assert.strictEqual(browser.memory.size, 0)))
    const cleared = (yield* api.GetUserDraft(address))!
    const base = {
      ...address,
      draftId: cleared.id,
      expectedRowVersion: cleared.rowVersion,
      expectedSession: cleared.session
    }
    yield* api.SaveUserDraft({ ...base, content: remote, editingFrom: "" })
    store.type("Later local typing", original)
    yield* Effect.promise(() => vi.waitFor(() => assert.strictEqual(browser.memory.size, 0)))
    const after = (yield* api.GetUserDraft(address))!
    assert.strictEqual(after.clearedVersion, cleared.clearedVersion)
    const replay = yield* api.SaveUserDraft({ ...base, content: remote, editingFrom: "" })
    assert.strictEqual(replay.content, remote, "an acknowledged old clear cannot block post-clear typing")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

for (const original of ["different fresh text", "retyped original"] as const)
  it.live(`a whole-field clear records its event even when the final text is ${original}`, () =>
    Effect.gen(function* () {
      reset()
      const api = yield* client(),
        ownerId = (yield* api.Whoami()).id
      const address = { ownerId, targetId: `root-event:${original}`, field: "Instruction" }
      const old = "Original text",
        fresh = original === "retyped original" ? old : "Fresh text"
      const first = yield* api.SaveUserDraft({
        ...address,
        content: old,
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null
      })
      const base = {
        ...address,
        draftId: first.id,
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session
      }
      const cleared = editingOrigin(old, old, "")
      const intent = editingOrigin(cleared, "", fresh)
      yield* api.SaveUserDraft({ ...base, content: fresh, editingFrom: intent })
      const late = yield* api.SaveUserDraft({
        ...base,
        content: "Different stale text typed before the clear",
        editingFrom: old
      })
      assert.strictEqual(late.content, fresh)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

it.live("a clear made before the first server draft survives delivery of only the final copy", () =>
  Effect.gen(function* () {
    reset()
    const api = yield* client(),
      ownerId = (yield* api.Whoami()).id
    const base = {
      ownerId,
      targetId: "first-root-clear",
      field: "Instruction",
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null
    }
    const cleared = editingOrigin("Host's saved instruction", "Host's saved instruction", "")
    const intent = editingOrigin(cleared, "", "Fresh replacement")
    const saved = yield* api.SaveUserDraft({ ...base, content: "Fresh replacement", editingFrom: intent })
    const late = yield* api.SaveUserDraft({
      ...base,
      content: "Old offline text",
      editingFrom: "Host's saved instruction"
    })
    assert.strictEqual(late.content, saved.content)
    assert.strictEqual(saved.clearedVersion, saved.rowVersion)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live(
  "fresh text descended from an unacknowledged clear reloads without bypassing a different device's later clear",
  () =>
    Effect.gen(function* () {
      reset()
      const api = yield* client(),
        ownerId = (yield* api.Whoami()).id
      const address = { ownerId, targetId: "lost-clear-ack", field: "Instruction" }
      const old = "Before the clear",
        fresh = "Typed after my clear"
      const first = yield* api.SaveUserDraft({
        ...address,
        content: old,
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null
      })
      const base = {
        ...address,
        draftId: first.id,
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session
      }
      const intent = editingOrigin(old, old, "")
      // The empty request reached the server, but the page never heard its acknowledgement.
      const cleared = yield* api.SaveUserDraft({ ...base, content: "", editingFrom: intent })
      const copy = makeCopy(
        ownerId,
        address.targetId,
        address.field,
        { kind: "userDraft", payload: { ...base, content: fresh, editingFrom: editingOrigin(intent, "", fresh) } },
        1
      )
      browser.memory.set(copy.key, copy)
      const reopened = new UserDraftStore(ownerId, address.targetId, address.field, runWith(api))
      reopened.open()
      yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(reopened.snapshot().ready)))
      assert.strictEqual(reopened.snapshot().text, fresh)
      const continued = (yield* api.GetUserDraft(address))!
      assert.strictEqual(
        continued.clearedVersion,
        cleared.clearedVersion,
        "retrying the same clear event cannot advance its barrier"
      )
      const otherOrigin = editingOrigin(fresh, fresh, "")
      const otherClear = yield* api.SaveUserDraft({
        ...base,
        expectedRowVersion: continued.rowVersion,
        content: "",
        editingFrom: otherOrigin
      })
      const replay = yield* api.SaveUserDraft({
        ...(copy.save.kind === "userDraft" ? copy.save.payload : base),
        content: fresh
      })
      assert.strictEqual(replay.content, "", "the old event is not permission to bypass a later different deletion")
      assert.isAbove(otherClear.clearedVersion!, continued.clearedVersion!)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
