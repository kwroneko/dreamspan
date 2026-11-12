// "Undo all of this reply" (spec/WORKSHOP.md §3.6): every change one workshop run made, newest
// first, in one writer transaction; the first that can't be undone stops the rest, and the report
// says what was undone, what was refused and why, and what was left.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { textField } from "@rp/shared/editing.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { client, login, outcome, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** A workshop with a running run whose tools are called directly. */
const fixture = (dataDir: string, api: Api, n = 0) =>
  Effect.gen(function* () {
    const user = yield* api.Whoami()
    const chat = yield* api.CreateWorkshop({})
    const rolloutId = `r${n}-${chat.id}`
    yield* fixtureSql(dataDir, [
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
        params: [rolloutId, chat.id]
      }
    ])
    const registry = yield* ExecutionRegistry
    const context: ToolContext = {
      userId: user.id,
      chatId: chat.id,
      forkId: chat.currentForkId,
      slotId: chat.activeLeafSlotId as SlotId,
      versionId: "unused" as VersionId,
      rolloutId,
      toolCallId: "unused",
      leafSlotId: null,
      reader: yield* Reader,
      writer: yield* Writer,
      viewers: null,
      cache: new Map()
    }
    const run = (name: string, args: unknown, id: string) =>
      toolForKind(registry, "workshop", name)!.execute({ ...context, toolCallId: id }, args as never)
    const create = (name: string, id: string) =>
      Effect.map(run("create_card", { name, description: "Synthetic." }, id), (out) => {
        assert.isUndefined(out.isError, out.text)
        return JSON.parse(out.text).id as RefId
      })
    return { chat, rolloutId, run, create }
  })

/** A user's own save, so the agent's change is no longer the head. */
const userEdit = (api: Api, refId: RefId, content: string) =>
  Effect.gen(function* () {
    const field = textField(["description"])
    const before = yield* api.OpenEditor({ refId })
    const draft = yield* api.SaveEditorDraft({
      refId,
      field,
      content,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      baseRevisionId: before.ref.headRevisionId
    })
    yield* api.CommitEditorDrafts({
      refId,
      expectedRowVersion: before.ref.rowVersion,
      fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
      message: null
    })
  })

const cardNames = (api: Api) =>
  Effect.map(api.ListLibrary({ kind: "card" }), (rows) => rows.map((r) => r.label).toSorted())

describe("undo all of a reply", () => {
  it.live("undoes every change newest first, then reports nothing left", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const a = yield* f.create("Card A", "c1")
      yield* f.create("Card B", "c2")
      const edited = yield* f.run(
        "edit_card",
        { card: a, changes: [{ field: "description", text: "Agent edit." }] },
        "c3"
      )
      assert.isUndefined(edited.isError, edited.text)
      const report = yield* api.UndoRolloutEffects({ chatId: f.chat.id, rolloutId: f.rolloutId })
      assert.deepStrictEqual(
        report.undone.map((e) => e.toolCallId),
        ["c3", "c2", "c1"]
      )
      assert.isNull(report.refused)
      assert.isEmpty(report.left)
      assert.isTrue(report.undone.every((e) => e.undoneAt !== null))
      assert.notInclude(yield* cardNames(api), "Card A")
      assert.notInclude(yield* cardNames(api), "Card B")
      const listed = yield* api.ListRolloutEffects({ chatId: f.chat.id })
      assert.isTrue(listed.every((e) => e.undoneAt !== null))
      const again = yield* api.UndoRolloutEffects({ chatId: f.chat.id, rolloutId: f.rolloutId })
      assert.deepStrictEqual(again, { undone: [], refused: null, left: [] })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("stops at the first refusal, keeps what was undone and leaves the older ones untouched", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* f.create("Card P", "k1")
      const q = yield* f.create("Card Q", "k2")
      yield* f.create("Card R", "k3")
      yield* userEdit(api, q, "The user's own text.")
      const report = yield* api.UndoRolloutEffects({ chatId: f.chat.id, rolloutId: f.rolloutId })
      assert.deepStrictEqual(
        report.undone.map((e) => e.toolCallId),
        ["k3"]
      )
      assert.strictEqual(report.refused?.effect.toolCallId, "k2")
      assert.include(report.refused?.reason ?? "", "Changed since")
      assert.deepStrictEqual(
        report.left.map((e) => e.toolCallId),
        ["k1"]
      )
      // The refused change rolled back in its savepoint; the older one wasn't tried.
      const names = yield* cardNames(api)
      assert.include(names, "Card P")
      assert.include(names, "Card Q")
      assert.notInclude(names, "Card R")
      assert.strictEqual((yield* api.OpenEditor({ refId: q })).doc.description, "The user's own text.")
      const listed = yield* api.ListRolloutEffects({ chatId: f.chat.id })
      const state = Object.fromEntries(listed.map((e) => [e.toolCallId, e.undoneAt !== null]))
      assert.deepStrictEqual(state, { k1: false, k2: false, k3: true })
      // Single Undo still works on what was left.
      const k1 = listed.find((e) => e.toolCallId === "k1")!
      assert.isNotNull((yield* api.UndoRolloutEffect(k1)).undoneAt)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("is the owner's only, and only for a run in the named workshop", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const local = yield* client()
      const owner = yield* local.Whoami()
      yield* local.SetPassword({ userId: owner.id, currentPassword: null, newPassword: "alice-password" })
      const alice = yield* client({ cookie: (yield* login(owner.handle, "alice-password")).cookie })
      yield* alice.CreateUser({ handle: "bob", displayName: "Bob", role: "user", password: "bob-password" })
      const bob = yield* client({ cookie: (yield* login("bob", "bob-password")).cookie })
      const f = yield* fixture(config.dataDir, alice, 1)
      const other = yield* fixture(config.dataDir, alice, 2)
      const b = yield* fixture(config.dataDir, bob, 3)
      yield* f.create("Alice card", "a1")
      assert.strictEqual(
        yield* outcome(bob.UndoRolloutEffects({ chatId: f.chat.id, rolloutId: f.rolloutId })),
        "NotFound"
      )
      assert.strictEqual(
        yield* outcome(bob.UndoRolloutEffects({ chatId: b.chat.id, rolloutId: f.rolloutId })),
        "NotFound"
      )
      assert.strictEqual(
        yield* outcome(alice.UndoRolloutEffects({ chatId: other.chat.id, rolloutId: f.rolloutId })),
        "NotFound"
      )
      assert.include(yield* cardNames(alice), "Alice card")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
