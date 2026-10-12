// The composer's drafts over a real server (DESIGN §6.2): saved with row versions, undone
// from their server-side history, committed with the send that took their text (posted or
// queued), and saved by a closing page through POST /chats/composer. Cross-user access is in
// the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { DraftHistoryPolicy } from "@rp/shared/drafts.ts"
import { Effect } from "effect"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import { client, outcome, post, posted, serverLayer, testConfig, withServer } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const composer = (api: Api, chatId: ChatId, tipSlotId: SlotId | null) => api.GetComposer({ chatId, tipSlotId })

describe("the composer's drafts", () => {
  it.live("saves with row versions, and undoes from the server's history", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Harbor" })
      const at = { chatId: chat.id, tipSlotId: null }
      assert.isNull(yield* composer(api, chat.id, null))
      const first = yield* api.SaveComposer({ ...at, content: "The lantern swings.", expectedRowVersion: null })
      // Another tab, which hadn't seen that save, doesn't overwrite it.
      assert.strictEqual(
        yield* outcome(api.SaveComposer({ ...at, content: "stale", expectedRowVersion: null })),
        "StaleWrite"
      )
      const wiped = yield* api.SaveComposer({ ...at, content: "x", expectedRowVersion: first.rowVersion })
      assert.strictEqual((yield* composer(api, chat.id, null))?.content, "x")
      // Select-all plus a stray key is one step back.
      const [, before] = yield* api.ComposerHistory({ ...at, limit: 10 })
      const restored = yield* api.RestoreComposer({ ...at, seq: before!.seq, expectedRowVersion: wiped.rowVersion })
      assert.strictEqual(restored.content, "The lantern swings.")
      assert.strictEqual(
        yield* outcome(
          api.SaveComposer({
            ...at,
            content: "y".repeat(DraftHistoryPolicy.maxContentChars + 1),
            expectedRowVersion: restored.rowVersion
          })
        ),
        "TextTooLong"
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("is committed by the send that took its text, and goes on to the new tip", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Chapel" })
      const draft = yield* api.SaveComposer({
        chatId: chat.id,
        tipSlotId: null,
        content: "Knock twice.",
        expectedRowVersion: null
      })
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "Knock twice.",
          composerRowVersion: draft.rowVersion
        })
      )
      const moved = yield* composer(api, chat.id, sent.entry.slotId)
      assert.deepStrictEqual([moved?.status, moved?.content], ["committed", ""])
      assert.isNull(yield* composer(api, chat.id, null))

      // Typed on in another tab after the send left: that text stays, at the new tip.
      const typing = yield* api.SaveComposer({
        chatId: chat.id,
        tipSlotId: sent.entry.slotId,
        content: "Then wait.",
        expectedRowVersion: moved!.rowVersion
      })
      const next = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: sent.entry.slotId,
          branch: false,
          content: "Then",
          composerRowVersion: typing.rowVersion - 1
        })
      )
      const kept = yield* composer(api, chat.id, next.entry.slotId)
      assert.deepStrictEqual([kept?.status, kept?.content], ["active", "Then wait."])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("is committed when its text is queued behind a reply still being written", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Queue" })
      const sent = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "hi" }))
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const tip = reply.entry.slotId
      const draft = yield* api.SaveComposer({
        chatId: chat.id,
        tipSlotId: tip,
        content: "wait",
        expectedRowVersion: null
      })
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: tip,
        branch: false,
        content: "wait",
        composerRowVersion: draft.rowVersion
      })
      assert.strictEqual(queued._tag, "Queued")
      assert.strictEqual((yield* composer(api, chat.id, tip))?.status, "committed")
    }).pipe(
      Effect.scoped,
      Effect.provide(serverLayer(testConfig(), FakeGenerator.layer({ tokensPerSecond: 5, tokens: 20_000 })))
    )
  )

  it.live("takes a closing page's text with the editors' drafts, on top of another tab's", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Beacon" })
      const leaving = (composer: Record<string, unknown>) =>
        post("/library/drafts", { drafts: [], composers: [composer] })
      const at = { chatId: chat.id, tipSlotId: null }
      assert.strictEqual((yield* leaving({ ...at, content: "typed", expectedRowVersion: null })).status, 204)
      assert.strictEqual((yield* composer(api, chat.id, null))?.content, "typed")
      // Another tab saved meanwhile: this goes on top, theirs stays in the history.
      assert.strictEqual((yield* leaving({ ...at, content: "typed more", expectedRowVersion: null })).status, 204)
      assert.strictEqual((yield* composer(api, chat.id, null))?.content, "typed more")

      // A draft that moved on with a message appended at its tip isn't made again behind it.
      const draft = (yield* composer(api, chat.id, null))!
      const sent = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "hi" }))
      assert.strictEqual((yield* leaving({ ...at, content: "late", expectedRowVersion: draft.rowVersion })).status, 409)
      assert.isNull(yield* composer(api, chat.id, null))
      assert.strictEqual((yield* composer(api, chat.id, sent.entry.slotId))?.content, "typed more")
      assert.strictEqual(
        (yield* leaving({ ...at, chatId: "nope", content: "x", expectedRowVersion: null })).status,
        404
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
