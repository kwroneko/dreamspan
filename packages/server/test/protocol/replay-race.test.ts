import { assert, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { textField } from "@rp/shared/editing.ts"
import { client, outcome, testConfig, withServer } from "../support/config.ts"
import { FakeIndexedDb } from "./fakeIndexedDb.ts"
const idb = new FakeIndexedDb()
globalThis.indexedDB = idb as unknown as IDBFactory
const { keepCopy, makeCopy } = await import("../../../client/src/features/editor/backup.ts")
const { EditorStore } = await import("../../../client/src/features/editor/store.ts")
const tick = () => new Promise<void>((r) => setImmediate(r))
it.live("a failed backup replay must not replace typing and rebase it onto the successful live save", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Replay race", name: "Replay race" })
    const field = textField(["description"])
    const old = "The same long common prefix stays in this field. old"
    const newer = old + " UNIQUE NEW TYPING 851726"
    const draft = yield* api.SaveEditorDraft({
      expectedSession: null,
      refId: card.id,
      field,
      draftId: null,
      content: old,
      expectedRowVersion: null,
      baseRevisionId: card.headRevisionId
    })
    yield* Effect.promise(async () => {
      await keepCopy(
        makeCopy(
          "race-user",
          card.id,
          field,
          {
            kind: "editor",
            payload: {
              refId: card.id,
              field,
              draftId: draft.id,
              content: old,
              expectedRowVersion: draft.rowVersion,
              expectedSession: draft.session,
              baseRevisionId: card.headRevisionId
            }
          },
          Date.now()
        )
      )
      let saves = 0
      let failReplay!: (x: unknown) => void
      let releaseLive!: () => void
      const replay = new Promise<unknown>((r) => (failReplay = r))
      const live = new Promise<void>((r) => (releaseLive = r))
      const call = async (rpc: (client: never) => Effect.Effect<unknown, unknown>) => {
        let tag = ""
        let payload: unknown
        rpc(((t: string, p: unknown) => {
          tag = t
          payload = p
          return Effect.void
        }) as never)
        if (tag === "SaveEditorDraft") {
          saves++
          if (saves === 1) return replay
          if (saves === 2) await live
        }
        const exit = await Effect.runPromiseExit(
          (api as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>)[tag]!(payload)
        )
        return Exit.isSuccess(exit)
          ? { ok: true, value: exit.value }
          : { ok: false, error: { tag: "Failed", message: String(exit.cause) } }
      }
      const store = new EditorStore(card.id, "race-user", call as never, {
        setTimer: () => 0,
        clearTimer: () => {},
        now: () => Date.now(),
        keepalive: async () => false
      })
      const loading = store.load()
      while (saves < 1) await tick()
      store.setText(["description"], newer)
      const saving = store.flush()
      while (saves < 2) await tick()
      failReplay({ ok: false, error: { tag: "Offline", message: "replay failed" } })
      await loading
      releaseLive()
      await saving
      await store.flush()
      const now = await Effect.runPromise(api.OpenEditor({ refId: card.id }))
      assert.strictEqual(now.drafts[0]!.content, newer)
    })
  }).pipe(Effect.scoped, withServer(testConfig()))
)

it.live("an offline copy restored after a newer server save must retain its base while keepalive is out", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Failed replay base", name: "Failed replay base" })
    const field = textField(["description"])
    const base = "A long common prefix that both tabs saw. "
    const initial = yield* api.SaveEditorDraft({
      expectedSession: null,
      refId: card.id,
      field,
      draftId: null,
      content: base,
      expectedRowVersion: null,
      baseRevisionId: card.headRevisionId
    })
    const other = base + "OTHER TAB UNIQUE 719624"
    const stale = base + "offline B"
    yield* api.SaveEditorDraft({
      refId: card.id,
      field,
      draftId: initial.id,
      content: other,
      expectedRowVersion: initial.rowVersion,
      expectedSession: initial.session,
      baseRevisionId: card.headRevisionId
    })
    yield* Effect.promise(async () => {
      idb.clear()
      await keepCopy(
        makeCopy(
          "stale-user",
          card.id,
          field,
          {
            kind: "editor",
            payload: {
              refId: card.id,
              field,
              draftId: initial.id,
              content: stale,
              expectedRowVersion: initial.rowVersion,
              expectedSession: initial.session,
              baseRevisionId: card.headRevisionId
            }
          },
          Date.now()
        )
      )
      let saves = 0
      const call = async (rpc: (client: never) => Effect.Effect<unknown, unknown>) => {
        let tag = ""
        let payload: unknown
        rpc(((t: string, p: unknown) => {
          tag = t
          payload = p
          return Effect.void
        }) as never)
        if (tag === "SaveEditorDraft" && ++saves === 1)
          return { ok: false, error: { tag: "Offline", message: "no connection" } }
        const exit = await Effect.runPromiseExit(
          (api as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>)[tag]!(payload)
        )
        return Exit.isSuccess(exit)
          ? { ok: true, value: exit.value }
          : { ok: false, error: { tag: "Failed", message: String(exit.cause) } }
      }
      const store = new EditorStore(card.id, "stale-user", call as never, {
        setTimer: () => 0,
        clearTimer: () => {},
        now: () => Date.now(),
        keepalive: () => new Promise(() => {})
      })
      await store.load()
      store.beacon()
      store.setText(["description"], stale + " plus")
      await store.flush()
      await store.commit(null)
      const recovered = await Effect.runPromise(api.ListRecoveredTexts({ limit: 10, before: null }))
      assert.isTrue(recovered.some((x) => x.content === other))
    })
  }).pipe(Effect.scoped, withServer(testConfig()))
)

it.live("typing after a refused replay keeps the revision base even after that session was committed", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Ended replay", name: "Synthetic" })
    const field = textField(["description"])
    const initial = yield* api.SaveEditorDraft({
      refId: card.id,
      field,
      draftId: null,
      content: "Old draft",
      expectedRowVersion: null,
      expectedSession: null,
      baseRevisionId: card.headRevisionId
    })
    const remote = yield* api.SaveEditorDraft({
      refId: card.id,
      field,
      draftId: initial.id,
      content: "Other tab committed",
      expectedRowVersion: initial.rowVersion,
      expectedSession: initial.session,
      baseRevisionId: card.headRevisionId
    })
    yield* api.CommitEditorDrafts({
      refId: card.id,
      expectedRowVersion: card.rowVersion,
      fields: [{ field, draftId: remote.id, expectedRowVersion: remote.rowVersion }],
      message: null
    })
    yield* Effect.promise(async () => {
      idb.clear()
      await keepCopy(
        makeCopy(
          "ended-replay",
          card.id,
          field,
          {
            kind: "editor",
            payload: {
              refId: card.id,
              field,
              draftId: initial.id,
              content: "Offline edit",
              expectedRowVersion: initial.rowVersion,
              expectedSession: initial.session,
              baseRevisionId: card.headRevisionId
            }
          },
          Date.now()
        )
      )
      let saves = 0
      let savedBase: unknown
      const call = async (rpc: (client: never) => Effect.Effect<unknown, unknown>) => {
        let tag = ""
        let payload: unknown
        rpc(((name: string, value: unknown) => {
          tag = name
          payload = value
          return Effect.void
        }) as never)
        if (tag === "SaveEditorDraft") {
          if (++saves === 1) return { ok: false, error: { tag: "Offline", message: "Replay refused" } }
          savedBase = (payload as { baseRevisionId: unknown }).baseRevisionId
        }
        const exit = await Effect.runPromiseExit(
          (api as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>)[tag]!(payload)
        )
        return Exit.isSuccess(exit)
          ? { ok: true, value: exit.value }
          : { ok: false, error: { tag: "Failed", message: String(exit.cause) } }
      }
      const store = new EditorStore(card.id, "ended-replay", call as never, {
        setTimer: () => 0,
        clearTimer: () => {},
        now: Date.now,
        keepalive: () => new Promise(() => {})
      })
      await store.load()
      store.beacon()
      store.setText(["description"], "Offline edit plus typing")
      await store.flush()
      assert.strictEqual(savedBase, card.headRevisionId)
      const current = await Effect.runPromise(api.OpenEditor({ refId: card.id }))
      const committed = await Effect.runPromise(
        outcome(
          api.CommitEditorDrafts({
            refId: card.id,
            expectedRowVersion: current.ref.rowVersion,
            fields: current.drafts
              .filter((draft) => draft.status === "active")
              .map((draft) => ({ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion })),
            message: null
          })
        )
      )
      assert.strictEqual(committed, "EditConflict")
    })
  }).pipe(Effect.scoped, withServer(testConfig()))
)
