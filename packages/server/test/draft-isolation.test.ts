import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { textField } from "@rp/shared/editing.ts"
import { client, outcome, post, testConfig, withServer, typeInto } from "./support/config.ts"
it.live("foreign draft and revision metadata are rejected independently of the target", () =>
  Effect.gen(function* () {
    const a = yield* client({ "Remote-User": "n5-alice" })
    const b = yield* client({ "Remote-User": "n5-bob" })
    const ac = yield* a.CreateChat({ title: "Alice" })
    const bc = yield* b.CreateChat({ title: "Bob" })
    const ad = yield* typeInto(a, ac.id, null, "ALICE PRIVATE")
    const bd = yield* typeInto(b, bc.id, null, "BOB PRIVATE")
    const ar = yield* a.CreateCard({ label: "Alice card", name: "Alice" })
    const br = yield* b.CreateCard({ label: "Bob card", name: "Bob" })
    const foreign = yield* a.SaveEditorDraft({
      expectedSession: null,
      refId: ar.id,
      field: textField(["description"]),
      draftId: null,
      content: "ALICE EDITOR PRIVATE",
      expectedRowVersion: null,
      baseRevisionId: ar.headRevisionId
    })
    const payload = {
      next: false,
      chatId: bc.id,
      draftId: ad.id,
      rowVersion: ad.rowVersion,
      session: ad.session,
      operationId: "foreign-test",
      content: "BOB PROVIDED"
    }
    const save = yield* outcome(b.SaveComposer(payload))
    const copy = yield* outcome(b.OpenComposer({ chatId: bc.id, tipSlotId: null, copyFrom: ad.id }))
    const editor = yield* outcome(
      b.SaveEditorDraft({
        refId: br.id,
        field: textField(["description"]),
        draftId: foreign.id,
        content: "BOB EDIT",
        expectedRowVersion: foreign.rowVersion,
        expectedSession: foreign.session,
        baseRevisionId: ar.headRevisionId
      })
    )
    const keepalive = yield* post(
      "/library/drafts",
      { drafts: [], composers: [{ ...payload, operationId: "foreign-keepalive" }] },
      { "Remote-User": "n5-bob" }
    )
    console.log(
      "FOREIGN_METADATA",
      JSON.stringify({
        save,
        copy,
        editor,
        keepalive: keepalive.status,
        aliceComposer: (yield* a.OpenComposer({ chatId: ac.id, tipSlotId: null })).content,
        bobOriginal: bd.content
      })
    )
    assert.deepStrictEqual([save, copy, editor, keepalive.status], ["NotFound", "NotFound", "NotFound", 404])
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)
