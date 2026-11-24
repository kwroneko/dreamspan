// The assistant's version tools (spec/WORKSHOP-CARDS.md §9, unit C9): read_revision and
// diff_revisions read any revision by number, id or latest; revert_change takes one revision's
// change back and keeps later edits, or writes nothing on a conflict and shows both texts; every
// write tool takes a message for its revision; and the Versions skill holds them all.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import { unitKey } from "@dreamspan/shared/changeReversal.ts"
import { newLorebookEntry } from "@dreamspan/shared/docs/lorebook.ts"
import { newCardDoc, textField } from "@dreamspan/shared/editing.ts"
import type { Doc, RefId } from "@dreamspan/shared/library.ts"
import { unifiedDiff } from "@dreamspan/shared/unifiedDiff.ts"
import { builtinSkills } from "../src/agent/skills.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const ORIGINAL = "Mara keeps the lighthouse.\nShe counts ships at night.\nShe writes to no one."

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
    const call = (name: string, args: unknown, id: string, options?: Pick<ToolContext, "countTokens" | "window">) =>
      toolForKind(registry, "workshop", name)!.execute({ ...context, ...options, toolCallId: id }, args as never)
    const run = (name: string, args: unknown, id: string, options?: Pick<ToolContext, "countTokens" | "window">) =>
      Effect.map(call(name, args, id, options), (out) => {
        assert.isUndefined(out.isError, out.text)
        return out.text
      })
    const made = yield* (yield* Writer).CreateEntity({
      userId: user.id,
      kind: "card",
      label: "Mara Quill",
      subtitle: "",
      doc: { ...newCardDoc("Mara Quill"), description: ORIGINAL, personality: "Quiet." },
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const card = made.ref.id as RefId
    const revisions = () => api.ListRevisions({ refId: card, limit: 50 })
    const doc = () => Effect.map(api.OpenEditor({ refId: card }), (s) => s.doc)
    const save = (refId: RefId, changes: Doc) =>
      Effect.gen(function* () {
        const { ref, doc } = yield* api.OpenEditor({ refId })
        return yield* context.writer.EditRef({
          userId: user.id,
          refId,
          expectedRowVersion: ref.rowVersion,
          doc: { ...doc, ...changes },
          message: null,
          commitDraft: null
        })
      })
    return { chat, call, run, card, revisions, doc, registry, context, save }
  })

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

const editDescription = (f: Effect.Success<ReturnType<typeof fixture>>, id: string, message?: string) =>
  f.run(
    "edit_card",
    {
      card: f.card,
      changes: [{ field: "description", find: "She counts ships at night.", replace: "She counts gulls at dawn." }],
      ...(message ? { message } : {})
    },
    id
  )

describe("version tools", () => {
  it.live("read a revision by number, id or latest, and refuse one it doesn't have", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* editDescription(f, "e1")
      const first = JSON.parse(
        yield* f.run("read_revision", { kind: "card", item: "Mara Quill", revision: "1" }, "r1")
      ) as { number: number; doc: { description: string } }
      assert.strictEqual(first.number, 1)
      assert.strictEqual(first.doc.description, ORIGINAL)
      const latest = JSON.parse(yield* f.run("read_revision", { kind: "card", item: f.card, revision: "latest" }, "r2"))
      assert.include(latest.doc.description, "gulls at dawn")
      const [newest] = yield* f.revisions()
      const byId = JSON.parse(yield* f.run("read_revision", { kind: "card", item: f.card, revision: newest!.id }, "r3"))
      assert.strictEqual(byId.number, 2)
      const missing = yield* f.call("read_revision", { kind: "card", item: f.card, revision: "9" }, "r4")
      assert.isTrue(missing.isError)
      assert.include(missing.text, "has no revision 9")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("diff two revisions as a unified diff, by field, and give a continuation cursor", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* editDescription(f, "e1")
      yield* userEdit(api, f.card, "personality", "Loud.")
      const diff = yield* f.run("diff_revisions", { kind: "card", item: f.card, from: "1" }, "d1")
      assert.include(diff, "revision 1 → now")
      assert.include(diff, "-She counts ships at night.\n+She counts gulls at dawn.")
      assert.include(diff, "personality: Quiet. → Loud.")
      const one = yield* f.run("diff_revisions", { kind: "card", item: f.card, from: "1", to: "2" }, "d2")
      assert.notInclude(one, "personality")
      const only = yield* f.run(
        "diff_revisions",
        { kind: "card", item: f.card, from: "1", fields: ["personality"] },
        "d3"
      )
      assert.notInclude(only, "gulls")
      // A page too small for all changes gives a cursor for the rest.
      yield* userEdit(api, f.card, "scenario", "Fog. ".repeat(400))
      const paged = yield* f.run("diff_revisions", { kind: "card", item: f.card, from: "1", max_tokens: 200 }, "d4")
      assert.match(paged, /\[Continue with cursor=".*"\]/)
      const same = yield* f.run("diff_revisions", { kind: "card", item: f.card, from: "latest" }, "d5")
      assert.include(same, "No differences")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it("writes unified hunks with context, joining near ones", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n")
    const after = ["a", "B", "c", "d", "e", "f", "g", "h", "I", "j"].join("\n")
    assert.strictEqual(
      unifiedDiff(before, after),
      ["@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", " d", "@@ -7,4 +7,4 @@", " g", " h", "-i", "+I", " j"].join("\n")
    )
    assert.strictEqual(unifiedDiff("x", "x"), "")
  })

  it.live("compares the same saved revisions across bounded pages of entries and a long field", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const book = yield* api.CreateLorebook({ label: "Fog banks" })
      const entries = Array.from({ length: 6 }, (_, i) => ({ ...newLorebookEntry(i), content: `Old entry ${i}.` }))
      yield* f.save(book.id, { entries })
      const next = entries.map((entry, i) => ({
        ...entry,
        content: i === 2 ? "🌫️ Dense fog. ".repeat(50) : `New entry ${i}.`
      }))
      yield* f.save(book.id, { entries: next })
      const args = { kind: "lorebook", item: book.id, from: "2", fields: ["entries"] }
      const options = { countTokens: (text: string) => Effect.succeed(text.length) }
      const full = yield* f.run("diff_revisions", { ...args, max_tokens: 8000 }, "full", options)
      const cursors = new Set<string>()
      let cursor: string | undefined
      let combined = ""
      for (let i = 0; i < 30; i++) {
        const page = yield* f.run("diff_revisions", { ...args, max_tokens: 200, cursor }, `page-${i}`, options)
        assert.isAtMost(page.length, 200)
        const footer = /\n\n\[Continue with cursor="([^"]+)"\]$/.exec(page)
        const body = footer === null ? page : page.slice(0, footer.index)
        if (cursor?.endsWith(":0")) combined += "\n\n"
        combined += i === 0 && body.startsWith("lorebook ") ? body.slice(body.indexOf("\n\n") + 2) : body
        if (footer === null) break
        cursor = footer[1]!
        assert.isFalse(cursors.has(cursor), "the cursor must advance on each page")
        cursors.add(cursor)
        if (i === 0) yield* f.save(book.id, { entries: [] })
      }
      assert.isAbove(cursors.size, 1)
      assert.strictEqual(combined, full.slice(full.indexOf("\n\n") + 2))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("revert_change takes one revision's change back and keeps later edits, with its message", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* editDescription(f, "e1")
      yield* userEdit(api, f.card, "personality", "Loud.")
      const result = JSON.parse(
        yield* f.run(
          "revert_change",
          { kind: "card", item: "Mara Quill", revision: "2", message: "Back to ships at night" },
          "v1"
        )
      ) as { reverted: boolean; fields: Array<string> }
      assert.isTrue(result.reverted)
      assert.deepStrictEqual(result.fields, ["description"])
      const now = yield* f.doc()
      assert.strictEqual(now.description, ORIGINAL)
      assert.strictEqual(now.personality, "Loud.")
      const [newest] = yield* f.revisions()
      assert.strictEqual(newest!.message, "Back to ships at night")
      assert.strictEqual(newest!.origin, "agent")
      // The edit it took back says Reverted on its row; the revert is a change of its own, undoable.
      const effects = yield* api.ListRolloutEffects({ chatId: f.chat.id })
      const edit = effects.find((e) => e.toolCallId === "e1")!
      assert.deepStrictEqual(edit.reversion?.fields, [unitKey(["description"])])
      const revert = effects.find((e) => e.toolCallId === "v1")!
      assert.strictEqual(revert.kind, "library.revise")
      assert.strictEqual(revert.title, "Reverted a change to the card Mara Quill")
      // Not the user's revert: the next turn's tail line doesn't tell it back.
      const told = yield* (yield* Reader).ChatReversalsSince({ userId: (yield* api.Whoami()).id, chatId: f.chat.id })
      assert.deepStrictEqual(told.reversals, [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("revert_change on a conflict writes nothing and shows the field now and before", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* editDescription(f, "e1")
      const changed = ORIGINAL.replace("ships at night", "gulls at noon")
      yield* userEdit(api, f.card, "description", changed)
      const before = (yield* f.revisions()).length
      const result = JSON.parse(yield* f.run("revert_change", { kind: "card", item: f.card, revision: "2" }, "v1")) as {
        reverted: boolean
        conflicts: Array<{ field: string; now: string; before_the_change: string }>
      }
      assert.isFalse(result.reverted)
      assert.deepStrictEqual(result.conflicts, [{ field: "description", now: changed, before_the_change: ORIGINAL }])
      assert.strictEqual((yield* f.revisions()).length, before)
      assert.strictEqual((yield* f.doc()).description, changed)
      const first = yield* f.call("revert_change", { kind: "card", item: f.card, revision: "1" }, "v2")
      assert.isTrue(first.isError)
      assert.include(first.text, "first revision")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("every write takes a message for its revision", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* editDescription(f, "e1", "Gulls, not ships")
      assert.strictEqual((yield* f.revisions())[0]!.message, "Gulls, not ships")
      yield* f.run("edit_card", { card: f.card, changes: [{ field: "personality", text: "Loud." }] }, "e2")
      assert.strictEqual((yield* f.revisions())[0]!.message, "Edited in the workshop")
      // Without one, the built message.
      const created = JSON.parse(
        yield* f.run("create_card", { name: "Ove Brekke", message: "A ferryman for Mara" }, "c1")
      ) as { id: RefId }
      assert.strictEqual((yield* api.ListRevisions({ refId: created.id, limit: 5 }))[0]!.message, "A ferryman for Mara")
      const cloned = JSON.parse(
        yield* f.run("clone_card", { card: f.card, name: "Mara Copy", message: "A copy\nto try things" }, "k1")
      ) as { id: RefId }
      assert.strictEqual((yield* api.ListRevisions({ refId: cloned.id, limit: 5 }))[0]!.message, "A copy to try things")
      const [, first] = [...(yield* f.revisions())].reverse()
      const saved = yield* api.OpenEditor({ refId: f.card })
      yield* api.RestoreRevision({
        refId: f.card,
        revisionId: first!.id,
        expectedRowVersion: saved.ref.rowVersion,
        message: "Back to the first edit"
      })
      assert.strictEqual((yield* f.revisions())[0]!.message, "Back to the first edit")
      const long = yield* f.call(
        "revert_change",
        { kind: "card", item: f.card, revision: "2", message: "x".repeat(201) },
        "v9"
      )
      assert.isTrue(long.isError)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.effect("the Versions skill holds the version tools, all offered in a workshop", () =>
    Effect.gen(function* () {
      const versions = builtinSkills.find((s) => s.id === "versions")!
      assert.deepStrictEqual(versions.tools, [
        "list_revisions",
        "read_revision",
        "diff_revisions",
        "restore_revision",
        "revert_change"
      ])
      assert.isFalse(builtinSkills.some((s) => s.id !== "versions" && s.tools.includes("restore_revision")))
    })
  )
})
