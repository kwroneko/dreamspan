import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { textField } from "@rp/shared/editing.ts"
import { client, posted, outcome, testConfig, withServer, typeInto, takenFrom } from "./support/config.ts"
import { sendStFile } from "./support/stUpload.ts"

it.live("a late composer save reports recovery in Draft.recovered too", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Late save" })
    const before = yield* typeInto(api, chat.id, null, "sent original")
    yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: before.content,
        composer: takenFrom(before)
      })
    )
    const payload = {
      chatId: chat.id,
      draftId: before.id,
      rowVersion: before.rowVersion,
      session: before.session,
      next: false,
      operationId: crypto.randomUUID(),
      content: "late unseen text"
    }
    const late = yield* api.SaveComposer(payload)
    const recovered = yield* api.ListRecoveredTexts({ limit: 20, before: null })
    assert.isTrue(late.recovered)
    assert.isTrue(recovered.some((x) => x.content === "late unseen text"))
    assert.equal(late.draft?.recovered, 1)
    const replay = yield* api.SaveComposer(payload)
    assert.isTrue(replay.recovered)
    assert.equal(replay.draft?.recovered, 1)
    assert.equal((yield* api.ListRecoveredTexts({ limit: 20, before: null })).length, recovered.length)
  }).pipe(Effect.scoped, withServer(testConfig()))
)

it.live("restore, discard and commit with a foreign draft id return NotFound", () =>
  Effect.gen(function* () {
    const a = yield* client({ "Remote-User": "final-alice" })
    const b = yield* client({ "Remote-User": "final-bob" })
    const ar = yield* a.CreateCard({ label: "A", name: "A" })
    const br = yield* b.CreateCard({ label: "B", name: "B" })
    const field = textField(["description"])
    const save = (api: typeof a, ref: typeof ar, content: string) =>
      api.SaveEditorDraft({
        refId: ref.id,
        field,
        draftId: null,
        expectedSession: null,
        expectedRowVersion: null,
        baseRevisionId: ref.headRevisionId,
        content
      })
    const ad = yield* save(a, ar, "PRIVATE ALICE")
    const bd = yield* save(b, br, "PRIVATE BOB")
    const restore = yield* outcome(
      b.RestoreEditorDraft({ refId: br.id, field, draftId: ad.id, seq: 0, expectedRowVersion: bd.rowVersion })
    )
    const discard = yield* outcome(
      b.DiscardEditorDraft({ refId: br.id, field, draftId: ad.id, expectedRowVersion: bd.rowVersion })
    )
    const commit = yield* outcome(
      b.CommitEditorDrafts({
        refId: br.id,
        expectedRowVersion: br.rowVersion,
        fields: [{ field, draftId: ad.id, expectedRowVersion: bd.rowVersion }],
        message: null
      })
    )
    assert.equal((yield* a.OpenEditor({ refId: ar.id })).drafts[0]!.content, "PRIVATE ALICE")
    assert.equal((yield* b.OpenEditor({ refId: br.id })).drafts[0]!.content, "PRIVATE BOB")
    assert.deepStrictEqual([restore, discard, commit], ["NotFound", "NotFound", "NotFound"])
    // A stale version of an owned identity still follows the ordinary conflict path.
    const owned = { refId: br.id, field, draftId: bd.id, expectedRowVersion: bd.rowVersion + 1 }
    assert.deepStrictEqual(
      [
        yield* outcome(b.RestoreEditorDraft({ ...owned, seq: 0 })),
        yield* outcome(b.DiscardEditorDraft(owned)),
        yield* outcome(
          b.CommitEditorDrafts({
            refId: br.id,
            expectedRowVersion: br.rowVersion,
            fields: [{ field, draftId: bd.id, expectedRowVersion: bd.rowVersion + 1 }],
            message: null
          })
        )
      ],
      ["StaleWrite", "StaleWrite", "StaleWrite"]
    )
    assert.equal(
      yield* outcome(
        b.CommitEditorDrafts({
          refId: br.id,
          expectedRowVersion: br.rowVersion + 1,
          fields: [{ field, draftId: ad.id, expectedRowVersion: bd.rowVersion }],
          message: null
        })
      ),
      "NotFound"
    )
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live(
  "two import appends carry a pending composer save on its original base; a conflicting tab stays in history",
  () =>
    Effect.gen(function* () {
      const api = yield* client()
      const path = "chats/Final/import.jsonl"
      const file = (n: number) =>
        new TextEncoder().encode(
          [
            { chat_metadata: {} },
            ...Array.from({ length: n }, (_, i) => ({
              name: i % 2 ? "User" : "Bot",
              is_user: i % 2 === 1,
              mes: "Synthetic " + i,
              send_date: 1730000000000 + i
            }))
          ]
            .map((x) => JSON.stringify(x))
            .join("\n")
        )
      const upload = (n: number) =>
        Effect.gen(function* () {
          const run = yield* api.StartStImport({ unsupported: [] })
          yield* sendStFile(run.importId, path, file(n), { card: "none" })
        })
      yield* upload(2)
      const chat = (yield* api.ListChats({ limit: 10, before: null }))[0]!
      const original = yield* typeInto(api, chat.id, null, "prefix")
      // This is the base on which the user starts typing; the save arrives after two imports.
      yield* upload(3)
      yield* upload(4)
      const moved = yield* api.GetChat({ chatId: chat.id })
      const current = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      assert.equal(current.id, original.id)
      yield* typeInto(api, chat.id, null, "prefix other tab", current)
      const saved = yield* api.SaveComposer({
        chatId: chat.id,
        draftId: original.id,
        rowVersion: original.rowVersion,
        session: original.session,
        next: false,
        operationId: crypto.randomUUID(),
        content: "prefix typed during imports"
      })
      assert.equal(saved.draft?.key.field, moved.currentForkId)
      const states = yield* api.ComposerHistory({ chatId: chat.id, draftId: original.id, limit: 10 })
      const restored = yield* api.RestoreComposer({
        chatId: chat.id,
        draftId: original.id,
        seq: states[1]!.seq,
        expectedRowVersion: saved.draft!.rowVersion
      })
      assert.equal(restored.content, "prefix other tab")
    }).pipe(Effect.scoped, withServer(testConfig()))
)
