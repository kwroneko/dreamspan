// Revert and Redo of a workshop's library changes (spec/WORKSHOP-CARDS.md §8.1): a change taken
// back field by field on the item as it is now, keeping later edits; hunks of a field changed since
// are reversed where they apply cleanly; a conflict writes nothing until the user picks; Redo
// takes a revert back; Revert all reverts each item; a made item changed since is binned only when
// asked; the next turn is told once (§8.2).
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { EntityId, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import { unitKey } from "@dreamspan/shared/changeReversal.ts"
import { newCardDoc, textField } from "@dreamspan/shared/editing.ts"
import type { Doc, RefId } from "@dreamspan/shared/library.ts"
import { reversalNote } from "../src/agent/reversalNote.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const DESCRIPTION = unitKey(["description"])
const PERSONALITY = unitKey(["personality"])

/** A workshop with a running run whose tools are called directly, and a card of the user's. */
const fixture = (dataDir: string, api: Api) =>
  Effect.gen(function* () {
    const user = yield* api.Whoami()
    const chat = yield* api.CreateWorkshop({})
    const rolloutId = `r-${chat.id}`
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
      Effect.map(
        toolForKind(registry, "workshop", name)!.execute({ ...context, toolCallId: id }, args as never),
        (out) => {
          assert.isUndefined(out.isError, out.text)
          return out
        }
      )
    const made = yield* (yield* Writer).CreateEntity({
      userId: user.id,
      kind: "card",
      label: "Mara Quill",
      subtitle: "",
      doc: {
        ...newCardDoc("Mara Quill"),
        description: "Mara keeps the lighthouse.\nShe counts ships at night.\nShe writes to no one.",
        personality: "Quiet."
      },
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const card = made.ref.id as RefId
    const effects = () => api.ListRolloutEffects({ chatId: chat.id })
    const editKeys = (ids: ReadonlyArray<string>) =>
      Effect.map(effects(), (list) =>
        list
          .filter((e) => ids.includes(e.toolCallId))
          .map((e) => ({ rolloutId: e.rolloutId, toolCallId: e.toolCallId, seq: e.seq }))
      )
    const doc = () => Effect.map(api.OpenEditor({ refId: card }), (s) => s.doc as Doc)
    return { user, chat, rolloutId, run, card, effects, editKeys, doc }
  })

/** A user's own save of one text field. */
const userEdit = (api: Api, refId: RefId, key: string, content: string) =>
  Effect.gen(function* () {
    const field = textField([key])
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

const agentEdit = (f: Effect.Success<ReturnType<typeof fixture>>, changes: unknown, id: string) =>
  f.run("edit_card", { card: f.card, changes }, id)

describe("revert a change", () => {
  it.live("puts the fields back as a new revision of the user's, and the change says it's reverted", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(f, [{ field: "description", text: "Rewritten by the assistant." }], "c1")
      const keys = yield* f.editKeys(["c1"])
      const done = yield* api.RevertChange({ effects: keys, message: "Reverted the assistant's change of 14:02" })
      assert.deepStrictEqual(done.fields, [DESCRIPTION])
      assert.isEmpty(done.conflicts)
      assert.isString(done.reversalId)
      const now = yield* f.doc()
      assert.strictEqual(
        now.description,
        "Mara keeps the lighthouse.\nShe counts ships at night.\nShe writes to no one."
      )
      const [head] = yield* api.ListRevisions({ refId: f.card, limit: 1 })
      assert.strictEqual(head!.origin, "user")
      assert.strictEqual(head!.message, "Reverted the assistant's change of 14:02")
      const [effect] = (yield* f.effects()).filter((e) => e.toolCallId === "c1")
      // Undo's own record stays unused: the state is the reversal's.
      assert.isNull(effect!.undoneAt)
      assert.deepStrictEqual(effect!.reversion?.fields, [DESCRIPTION])
      assert.deepStrictEqual(effect!.reversion?.of, [DESCRIPTION])
      assert.deepStrictEqual(effect!.reversion?.reversals, [done.reversalId!])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("keeps a later edit of another field and of another part of the same field", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(
        f,
        [
          { field: "description", find: "She counts ships at night.", replace: "She counts gulls at dawn." },
          { field: "personality", text: "Loud." }
        ],
        "c1"
      )
      // The user changes the last line, and the personality again.
      yield* userEdit(
        api,
        f.card,
        "description",
        "Mara keeps the lighthouse.\nShe counts gulls at dawn.\nShe writes to her sister."
      )
      yield* userEdit(api, f.card, "personality", "Loud and kind.")
      const done = yield* api.RevertChange({ effects: yield* f.editKeys(["c1"]), fields: [DESCRIPTION] })
      assert.deepStrictEqual(done.fields, [DESCRIPTION])
      const now = yield* f.doc()
      assert.strictEqual(
        now.description,
        "Mara keeps the lighthouse.\nShe counts ships at night.\nShe writes to her sister."
      )
      assert.strictEqual(now.personality, "Loud and kind.")
      const [effect] = (yield* f.effects()).filter((e) => e.toolCallId === "c1")
      // One of the change's two fields stands reverted.
      assert.deepStrictEqual(effect!.reversion?.fields, [DESCRIPTION])
      assert.deepStrictEqual(effect!.reversion?.of.toSorted(), [DESCRIPTION, PERSONALITY].toSorted())
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("writes nothing on a conflict, then takes the user's choices", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(
        f,
        [
          { field: "description", find: "ships at night", replace: "gulls at dawn" },
          { field: "personality", text: "Loud." }
        ],
        "c1"
      )
      yield* userEdit(
        api,
        f.card,
        "description",
        "Mara keeps the lighthouse.\nShe counts crabs at noon.\nShe writes to no one."
      )
      const keys = yield* f.editKeys(["c1"])
      const [before] = yield* api.ListRevisions({ refId: f.card, limit: 1 })
      const conflict = yield* api.RevertChange({ effects: keys })
      assert.isNull(conflict.reversalId)
      assert.deepStrictEqual(
        conflict.conflicts.map((c) => c.field),
        [DESCRIPTION]
      )
      assert.include(String(conflict.conflicts[0]!.now), "crabs at noon")
      assert.include(String(conflict.conflicts[0]!.before), "ships at night")
      const [still] = yield* api.ListRevisions({ refId: f.card, limit: 1 })
      assert.strictEqual(still!.id, before!.id)
      // Keep now: the rest is reverted, the description stays.
      const rest = yield* api.RevertChange({
        effects: keys,
        expectedHead: conflict.head,
        choices: { [DESCRIPTION]: "now" }
      })
      assert.deepStrictEqual(rest.fields, [PERSONALITY])
      let now = yield* f.doc()
      assert.include(String(now.description), "crabs at noon")
      assert.strictEqual(now.personality, "Quiet.")
      // Take before, as a separate revert of the field.
      const taken = yield* api.RevertChange({
        effects: keys,
        fields: [DESCRIPTION],
        expectedHead: (yield* api.OpenEditor({ refId: f.card })).ref.headRevisionId,
        choices: { [DESCRIPTION]: "before" }
      })
      assert.deepStrictEqual(taken.fields, [DESCRIPTION])
      now = yield* f.doc()
      assert.include(String(now.description), "ships at night")
      const [effect] = (yield* f.effects()).filter((e) => e.toolCallId === "c1")
      assert.strictEqual(effect!.reversion?.fields.length, 2)
      // Two reverts hold its fields, newest first.
      assert.deepStrictEqual(effect!.reversion?.reversals, [taken.reversalId!, rest.reversalId!])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("refreshes stale choices without writing either field", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(
        f,
        [
          { field: "description", text: "Assistant edit." },
          { field: "personality", text: "Loud." }
        ],
        "c1"
      )
      const effects = yield* f.editKeys(["c1"])
      yield* userEdit(api, f.card, "description", "First conflicting value.")
      const preview = yield* api.RevertChange({ effects, dryRun: true })
      yield* userEdit(api, f.card, "description", "New unseen edit.")
      const stale = yield* api.RevertChange({
        effects,
        expectedHead: preview.head,
        choices: { [DESCRIPTION]: "before" }
      })
      assert.isNull(stale.reversalId)
      assert.notStrictEqual(stale.head, preview.head)
      assert.strictEqual(stale.conflicts[0]?.now, "New unseen edit.")
      const now = yield* f.doc()
      assert.strictEqual(now.description, "New unseen edit.")
      assert.strictEqual(now.personality, "Loud.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("covers several edits of a turn as one change, each recorded with its own fields", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(f, [{ field: "description", text: "First." }], "c1")
      yield* agentEdit(f, [{ field: "personality", text: "Second." }], "c2")
      const dry = yield* api.RevertChange({ effects: yield* f.editKeys(["c1", "c2"]), dryRun: true })
      assert.deepStrictEqual(dry.fields.toSorted(), [DESCRIPTION, PERSONALITY].toSorted())
      assert.isNull(dry.reversalId)
      assert.strictEqual((yield* f.doc()).description, "First.")
      yield* api.RevertChange({ effects: yield* f.editKeys(["c1", "c2"]) })
      const now = yield* f.doc()
      assert.include(String(now.description), "lighthouse")
      assert.strictEqual(now.personality, "Quiet.")
      const listed = (yield* f.effects()).filter((e) => e.kind === "library.revise")
      assert.deepStrictEqual(listed.find((e) => e.toolCallId === "c1")!.reversion?.fields, [DESCRIPTION])
      assert.deepStrictEqual(listed.find((e) => e.toolCallId === "c2")!.reversion?.fields, [PERSONALITY])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("keeps a user save between two edits selected for one revert", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const before = yield* f.doc()
      yield* agentEdit(f, [{ field: "description", text: "First." }], "c1")
      yield* userEdit(api, f.card, "scenario", "Saved during the reply.")
      yield* agentEdit(f, [{ field: "personality", text: "Second." }], "c2")
      const reverted = yield* api.RevertChange({ effects: yield* f.editKeys(["c1", "c2"]) })
      assert.isString(reverted.reversalId)
      assert.deepStrictEqual(yield* f.doc(), { ...before, scenario: "Saved during the reply." })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("reverts a lorebook's entries by identity; an entry the user deleted since is a conflict", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const book = yield* api.CreateLorebook({ label: "Skerry Lore" })
      yield* f.run(
        "edit_lorebook",
        { lorebook: book.id, changes: [{ add: { uid: 1, content: "The old fact." } }] },
        "b0"
      )
      // Another call edits the entry and adds another.
      yield* f.run(
        "edit_lorebook",
        {
          lorebook: book.id,
          changes: [{ entry: 1, text: "The new fact." }, { add: { uid: 2, content: "A second fact." } }]
        },
        "b1"
      )
      const keys = yield* f.editKeys(["b1"])
      const done = yield* api.RevertChange({ effects: keys, dryRun: true })
      assert.deepStrictEqual(
        done.fields.toSorted(),
        [unitKey(["entries", "uid=1"]), unitKey(["entries", "uid=2"])].toSorted()
      )
      // Entry 1 is deleted since: taking back its edit conflicts; the added entry goes.
      yield* f.run("edit_lorebook", { lorebook: book.id, changes: [{ remove: 1 }] }, "b2")
      const conflict = yield* api.RevertChange({ effects: keys })
      assert.deepStrictEqual(
        conflict.conflicts.map((c) => c.field),
        [unitKey(["entries", "uid=1"])]
      )
      const rest = yield* api.RevertChange({
        effects: keys,
        expectedHead: conflict.head,
        choices: { [unitKey(["entries", "uid=1"])]: "now" }
      })
      assert.deepStrictEqual(rest.fields, [unitKey(["entries", "uid=2"])])
      const now = yield* api.OpenEditor({ refId: book.id })
      assert.deepStrictEqual(now.doc.entries, [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("redo", () => {
  it.live("takes a revert back on the item as it is now; the field can be reverted again", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(f, [{ field: "description", find: "ships at night", replace: "gulls at dawn" }], "c1")
      const keys = yield* f.editKeys(["c1"])
      const reverted = yield* api.RevertChange({ effects: keys })
      yield* userEdit(api, f.card, "personality", "Kind.")
      const redone = yield* api.RedoChange({ reversalId: reverted.reversalId! })
      assert.deepStrictEqual(redone.fields, [DESCRIPTION])
      const now = yield* f.doc()
      assert.include(String(now.description), "gulls at dawn")
      assert.strictEqual(now.personality, "Kind.")
      let [effect] = (yield* f.effects()).filter((e) => e.toolCallId === "c1")
      assert.deepStrictEqual(effect!.reversion?.fields, [])
      assert.deepStrictEqual(effect!.reversion?.reversals, [])
      const again = yield* api.RevertChange({ effects: keys })
      assert.deepStrictEqual(again.fields, [DESCRIPTION])
      ;[effect] = (yield* f.effects()).filter((e) => e.toolCallId === "c1")
      assert.deepStrictEqual(effect!.reversion?.reversals, [again.reversalId!])
      assert.include(String((yield* f.doc()).description), "ships at night")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("of a revert that isn't there is NotFound", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(f, [{ field: "description", text: "Rewritten." }], "c1")
      const reverted = yield* api.RevertChange({ effects: yield* f.editKeys(["c1"]) })
      const result = yield* outcome(api.RedoChange({ reversalId: `${reverted.reversalId}-other` }))
      assert.strictEqual(result, "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("revert all of this reply", () => {
  it.live("reverts an edited item three-way, keeping the user's later edit, and bins what the reply made", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(f, [{ field: "description", find: "ships at night", replace: "gulls at dawn" }], "c1")
      yield* f.run("create_card", { name: "Ove Brekke", description: "Synthetic." }, "c2")
      yield* userEdit(api, f.card, "personality", "Kind.")
      const report = yield* api.UndoRolloutEffects({ chatId: f.chat.id, rolloutId: f.rolloutId })
      assert.isNull(report.refused)
      assert.sameMembers(
        report.undone.map((e) => e.toolCallId),
        ["c1", "c2"]
      )
      const now = yield* f.doc()
      assert.include(String(now.description), "ships at night")
      assert.strictEqual(now.personality, "Kind.")
      const names = (yield* api.ListLibrary({ kind: "card" })).map((r) => r.label)
      assert.notInclude(names, "Ove Brekke")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("bins what the reply made with its current revision and marks its edits together", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const out = yield* f.run("create_card", { name: "Ove Brekke", description: "Creation text." }, "c1")
      const refId = JSON.parse(out.text).id as RefId
      yield* f.run("edit_card", { card: refId, changes: [{ field: "description", text: "Expanded text." }] }, "c2")
      const head = (yield* api.OpenEditor({ refId })).ref.headRevisionId
      const report = yield* api.UndoRolloutEffects({ chatId: f.chat.id, rolloutId: f.rolloutId })
      assert.isNull(report.refused)
      assert.sameMembers(
        report.undone.map((e) => e.toolCallId),
        ["c1", "c2"]
      )
      const [item] = (yield* api.ListBin({ limit: 50, before: null })).filter((i) => i.title === "Ove Brekke")
      yield* api.RestoreBinItem({ itemId: item!.id })
      const restored = yield* api.OpenEditor({ refId })
      assert.strictEqual(restored.ref.headRevisionId, head)
      assert.strictEqual(restored.doc.description, "Expanded text.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("stops at a conflict and says so", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(f, [{ field: "description", find: "ships at night", replace: "gulls at dawn" }], "c1")
      yield* userEdit(
        api,
        f.card,
        "description",
        "Mara keeps the lighthouse.\nShe counts crabs at noon.\nShe writes to no one."
      )
      const report = yield* api.UndoRolloutEffects({ chatId: f.chat.id, rolloutId: f.rolloutId })
      assert.strictEqual(report.refused?.effect.toolCallId, "c1")
      assert.include(report.refused!.reason, "Mara Quill changed since")
      assert.include(String((yield* f.doc()).description), "crabs at noon")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("a made item changed since", () => {
  it.live("requires confirmation in both Changes actions when a story uses the card", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const out = yield* f.run("create_card", { name: "Ove Brekke", description: "Synthetic." }, "c1")
      const { id, entityId } = JSON.parse(out.text) as { id: RefId; entityId: EntityId }
      const story = yield* api.CreateChat({ title: "Story" })
      yield* api.ChangeCast({ chatId: story.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.SendMessage({
        chatId: story.id,
        parentSlotId: null,
        branch: false,
        content: "The keeper arrives.",
        reply: false
      })
      assert.strictEqual((yield* api.OpenEditor({ refId: id })).usedByChats, 1)
      const [key] = yield* f.editKeys(["c1"])
      assert.strictEqual(yield* outcome(api.UndoRolloutEffect(key!)), "EffectUndoRefused")
      const report = yield* api.UndoRolloutEffects({ chatId: f.chat.id, rolloutId: f.rolloutId })
      assert.include(report.refused?.reason, "A chat uses this item")
      assert.isEmpty(report.undone)
      assert.isNotNull((yield* api.UndoRolloutEffect({ ...key!, binAnyway: true })).undoneAt)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("is binned only when asked", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const out = yield* f.run("create_card", { name: "Ove Brekke", description: "Synthetic." }, "c1")
      const ref = JSON.parse(out.text).id as RefId
      yield* userEdit(api, ref, "description", "Changed by the user.")
      const [made] = (yield* f.effects()).filter((e) => e.toolCallId === "c1")
      const key = { rolloutId: made!.rolloutId, toolCallId: made!.toolCallId, seq: made!.seq }
      const refused = yield* outcome(api.UndoRolloutEffect(key))
      assert.strictEqual(refused, "EffectUndoRefused")
      const binned = yield* api.UndoRolloutEffect({ ...key, binAnyway: true })
      assert.isNotNull(binned.undoneAt)
      assert.notInclude(
        (yield* api.ListLibrary({ kind: "card" })).map((r) => r.label),
        "Ove Brekke"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("the tail line", () => {
  it.live("tells the next turn what the user took back since the last reply, once", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* agentEdit(
        f,
        [
          { field: "description", text: "Rewritten." },
          { field: "personality", text: "Loud." }
        ],
        "c1"
      )
      yield* f.run("create_card", { name: "Ove Brekke", description: "Synthetic." }, "c2")
      yield* fixtureSql(config.dataDir, [
        {
          sql: "UPDATE rollouts SET status = 'completed', completed_at = ? WHERE id = ?",
          params: [Date.now() - 1, f.rolloutId]
        }
      ])
      const note = reversalNote(yield* Reader)
      const line = (yield* ExecutionRegistry).turnNotes.get("workshop.reversals")!.line
      const input = { userId: f.user.id, chatId: f.chat.id, kind: "workshop", state: {} as never, offered: [] }
      assert.isNull(yield* note.line(input))
      yield* api.RevertChange({ effects: yield* f.editKeys(["c1"]) })
      const [made] = (yield* f.effects()).filter((e) => e.toolCallId === "c2")
      yield* api.UndoRolloutEffect({ rolloutId: made!.rolloutId, toolCallId: made!.toolCallId, seq: made!.seq })
      assert.strictEqual(
        yield* line(input),
        "The user reverted your change to Mara Quill (Description, Personality).\nThe user undid Ove Brekke (in the bin)."
      )
      // A reply finishing after them: they were told.
      yield* fixtureSql(config.dataDir, [
        {
          sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at,completed_at) VALUES (?,?,'workshop','completed','assistant','interactive',1,1,?)",
          params: [`${f.rolloutId}-next`, f.chat.id, Date.now() + 1]
        }
      ])
      assert.isNull(yield* line(input))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
