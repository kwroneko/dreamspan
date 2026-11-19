// The composer's drafts over a real server (DESIGN §6.2): a draft per tip, saved onto the
// draft the text was typed into wherever its tip went, undone from server-side history,
// committed with the send that took their text (posted or queued), and saved by a closing
// page through POST /library/drafts. Cross-user access is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { type Draft, DraftHistoryPolicy } from "@dreamspan/shared/drafts.ts"
import { Effect } from "effect"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import {
  client,
  outcome,
  post,
  posted,
  serverLayer,
  testConfig,
  takenFrom,
  typeInto,
  withServer
} from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const open = (api: Api, chatId: ChatId, forkId: ForkId | null) => api.OpenComposer({ chatId, forkId })

/** The states of a draft's history, each restored and read back, newest first. */
const states = (api: Api, chatId: ChatId, forkId: ForkId | null) =>
  Effect.gen(function* () {
    let draft = yield* open(api, chatId, forkId)
    const texts: Array<string> = []
    for (const state of yield* api.ComposerHistory({ chatId, draftId: draft.id, limit: 50 })) {
      const restored = yield* api.RestoreComposer({
        chatId,
        draftId: draft.id,
        seq: state.seq,
        expectedRowVersion: draft.rowVersion
      })
      texts.push(restored.content)
      draft = restored
    }
    return texts
  })

describe("the composer's drafts", () => {
  it.live("are one per fork, saved with row versions, and undone from the server's history", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Harbor" })
      const empty = yield* open(api, chat.id, null)
      assert.deepStrictEqual([empty.content, empty.status], ["", "active"])
      assert.strictEqual((yield* open(api, chat.id, null)).id, empty.id)
      const first = yield* typeInto(api, chat.id, null, "The lantern swings in the wind.", empty)
      const wiped = yield* typeInto(api, chat.id, null, "x", first)
      // Select-all plus a stray key is one step back.
      const [, before] = yield* api.ComposerHistory({ chatId: chat.id, draftId: empty.id, limit: 10 })
      const restored = yield* api.RestoreComposer({
        chatId: chat.id,
        draftId: empty.id,
        seq: before!.seq,
        expectedRowVersion: wiped.rowVersion
      })
      assert.strictEqual(restored.content, "The lantern swings in the wind.")
      assert.strictEqual(
        yield* outcome(typeInto(api, chat.id, null, "y".repeat(DraftHistoryPolicy.maxContentChars + 1), restored)),
        "TextTooLong"
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("keeps another tab's text when a stale tab saves over it: one step back, then recovered", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Two tabs" })
      const read = yield* open(api, chat.id, null)
      const hello = yield* typeInto(api, chat.id, null, "hello", read)
      // The other tab saw "hello" and typed on, within the time typing coalesces...
      yield* typeInto(api, chat.id, null, "hello B", hello)
      // ...and this tab, which hadn't seen that, saves its own.
      const saved = yield* api.SaveComposer({
        next: false,
        operationId: crypto.randomUUID(),
        chatId: chat.id,
        draftId: hello.id,
        rowVersion: hello.rowVersion,
        session: hello.session,
        content: "hello A"
      })
      assert.deepStrictEqual([saved.draft?.content, saved.recovered], ["hello A", false])
      const [, before] = yield* api.ComposerHistory({ chatId: chat.id, draftId: hello.id, limit: 10 })
      assert.strictEqual(before?.length, "hello B".length)
      // The history ends with the send; that text doesn't, however short.
      yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "hello A",
          composer: takenFrom(saved.draft!)
        })
      )
      const recovered = yield* api.ListRecoveredTexts({ limit: 10, before: null })
      assert.deepStrictEqual(
        recovered.map((text) => text.content),
        ["hello B"]
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("is committed by the send that took its text, and stays with its fork", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Chapel" })
      const draft = yield* typeInto(api, chat.id, null, "Knock twice.")
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "Knock twice.",
          composer: takenFrom(draft)
        })
      )
      assert.deepStrictEqual(
        [sent.draft?.id, sent.draft?.status, sent.draft?.content, sent.draft?.key.field],
        [draft.id, "committed", "", sent.chat.currentForkId]
      )
      assert.strictEqual((yield* open(api, chat.id, null)).id, draft.id)

      // Typed on in another tab after the send left: that text stays, and the send says so.
      const typing = yield* typeInto(api, chat.id, null, "Then wait.")
      const next = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: sent.entry.slotId,
          branch: false,
          content: "Then",
          composer: takenFrom(typing)
        })
      )
      assert.deepStrictEqual([next.draft?.status, next.draft?.content], ["active", "Then wait."])
      const kept = yield* open(api, chat.id, next.chat.currentForkId)
      assert.deepStrictEqual([kept.id, kept.content], [draft.id, "Then wait."])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("saves text typed before another tab's message onto the fork's draft", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Late" })
      const read = yield* open(api, chat.id, null)
      // Another tab sends meanwhile, without this composer's text.
      const sent = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "hi" }))
      const late = yield* typeInto(api, chat.id, null, "late typing", read)
      assert.deepStrictEqual([late.id, late.key.field], [read.id, sent.chat.currentForkId])
      assert.strictEqual((yield* open(api, chat.id, null)).content, "late typing")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("is committed when its text is queued, and a late save of that text never reopens it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Queue" })
      const sent = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "hi" }))
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const tip = reply.entry.slotId
      const draft = yield* typeInto(api, chat.id, null, "wait")
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: tip,
        branch: false,
        content: "wait",
        composer: takenFrom(draft)
      })
      assert.strictEqual(queued._tag, "Queued")
      assert.strictEqual(queued.draft?.status, "committed")
      // A closing page sends the text it had before the send was answered.
      const late = yield* post("/library/drafts", {
        drafts: [],
        composers: [
          {
            next: false,
            operationId: crypto.randomUUID(),
            chatId: chat.id,
            draftId: draft.id,
            rowVersion: draft.rowVersion,
            session: draft.session,
            content: "wait!"
          }
        ]
      })
      assert.strictEqual(late.status, 204)
      const after = yield* open(api, chat.id, null)
      assert.deepStrictEqual([after.status, after.content], ["committed", ""])
      // Never lost: it's in the recovered texts.
      const [recovered] = yield* api.ListRecoveredTexts({ limit: 10, before: null })
      assert.strictEqual((yield* api.GetRecoveredText({ id: recovered!.id })).content, "wait!")
    }).pipe(
      Effect.scoped,
      Effect.provide(serverLayer(testConfig(), FakeGenerator.layer({ tokensPerSecond: 5, tokens: 20_000 })))
    )
  )

  it.live("puts text typed after a send in the session the send ends, or on top if it never arrived", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Next" })
      const next = (from: Draft, content: string) =>
        post("/library/drafts", {
          drafts: [],
          composers: [
            {
              operationId: crypto.randomUUID(),
              chatId: chat.id,
              draftId: from.id,
              rowVersion: from.rowVersion,
              session: from.session,
              next: true,
              content
            }
          ]
        })
      // The send never arrived: the next text goes on top, the unsent one kept.
      const unsent = yield* typeInto(api, chat.id, null, "never sent")
      assert.strictEqual((yield* next(unsent, "typed after")).status, 204)
      const kept = yield* open(api, chat.id, null)
      assert.strictEqual(kept.content, "typed after")
      // The send arrived: the next text starts the session after it.
      yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "typed after",
          composer: takenFrom(kept)
        })
      )
      assert.strictEqual((yield* next(kept, "the message after")).status, 204)
      const after = yield* open(api, chat.id, null)
      assert.deepStrictEqual([after.status, after.content], ["active", "the message after"])
      const recovered = yield* api.ListRecoveredTexts({ limit: 10, before: null })
      assert.deepStrictEqual(
        recovered.map((text) => text.content),
        ["never sent"]
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  for (const sentFirst of [false, true]) {
    it.live(`replaying a next-message save after its send does nothing (first sent: ${sentFirst})`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const chat = yield* api.CreateChat({ title: "Replay" })
        const first = yield* typeInto(api, chat.id, null, "FIRST")
        let tip: SlotId | null = null
        if (sentFirst) {
          const sent = yield* posted(
            api.SendMessage({
              chatId: chat.id,
              parentSlotId: tip,
              branch: false,
              content: first.content,
              composer: takenFrom(first)
            })
          )
          tip = sent.entry.slotId
        }
        const request = {
          chatId: chat.id,
          draftId: first.id,
          rowVersion: first.rowVersion,
          session: first.session,
          next: true,
          operationId: "next-copy",
          content: "NEXT"
        }
        const replay = () => post("/library/drafts", { drafts: [], composers: [request] })
        assert.strictEqual((yield* replay()).status, 204)
        const next = yield* open(api, chat.id, null)
        assert.strictEqual(next.content, "NEXT")
        yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: tip,
            branch: false,
            content: next.content,
            composer: takenFrom(next)
          })
        )
        const before = yield* api.ListRecoveredTexts({ limit: 100, before: null })
        assert.strictEqual((yield* replay()).status, 204)
        const after = yield* open(api, chat.id, null)
        assert.deepStrictEqual([after.status, after.content], ["committed", ""])
        assert.deepStrictEqual(yield* api.ListRecoveredTexts({ limit: 100, before: null }), before)
      }).pipe(Effect.scoped, withServer(testConfig()))
    )
  }

  it.live("a pending next-message receipt survives a server and worker restart", () =>
    Effect.gen(function* () {
      const config = testConfig()
      const { request, recovered } = yield* Effect.gen(function* () {
        const api = yield* client()
        const chat = yield* api.CreateChat({ title: "Durable replay" })
        const first = yield* typeInto(api, chat.id, null, "FIRST")
        const request = {
          chatId: chat.id,
          draftId: first.id,
          rowVersion: first.rowVersion,
          session: first.session,
          next: true,
          operationId: "survives-restart",
          content: "NEXT"
        }
        const saved = yield* api.SaveComposer(request)
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "NEXT",
            composer: takenFrom(saved.draft!)
          })
        )
        return {
          request,
          tip: sent.entry.slotId,
          recovered: yield* api.ListRecoveredTexts({ limit: 100, before: null })
        }
      }).pipe(Effect.scoped, withServer(config))
      yield* Effect.gen(function* () {
        const api = yield* client()
        assert.strictEqual((yield* post("/library/drafts", { drafts: [], composers: [request] })).status, 204)
        const after = yield* open(api, request.chatId, null)
        assert.deepStrictEqual([after.status, after.content], ["committed", ""])
        assert.deepStrictEqual(yield* api.ListRecoveredTexts({ limit: 100, before: null }), recovered)
      }).pipe(Effect.scoped, withServer(config))
    })
  )

  it.live("takes a closing page's text with the editors' drafts, onto the draft it was typed into", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Beacon" })
      const leaving = (draft: Draft, content: string, chatId: string = chat.id) =>
        post("/library/drafts", {
          drafts: [],
          composers: [
            {
              next: false,
              operationId: crypto.randomUUID(),
              chatId,
              draftId: draft.id,
              rowVersion: draft.rowVersion,
              session: draft.session,
              content
            }
          ]
        })
      // Two tabs read the empty composer.
      const read = yield* open(api, chat.id, null)
      assert.strictEqual((yield* leaving(read, "typed")).status, 204)
      assert.strictEqual((yield* open(api, chat.id, null)).content, "typed")
      // The other tab saved meanwhile: this goes on top, theirs stays in the history.
      assert.strictEqual((yield* leaving(read, "typed more")).status, 204)
      assert.strictEqual((yield* open(api, chat.id, null)).content, "typed more")
      assert.include(yield* states(api, chat.id, null), "typed")

      // Sent from one tab; a tab that read it before the send closes with text of its own.
      const before = yield* open(api, chat.id, null)
      yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: before.content,
          composer: takenFrom(before)
        })
      )
      assert.strictEqual((yield* leaving(before, "B unsent")).status, 204)
      assert.strictEqual((yield* open(api, chat.id, null)).content, "")
      assert.strictEqual((yield* open(api, chat.id, null)).status, "committed")
      const [recovered] = yield* api.ListRecoveredTexts({ limit: 10, before: null })
      assert.strictEqual((yield* api.GetRecoveredText({ id: recovered!.id })).content, "B unsent")
      assert.strictEqual((yield* leaving(read, "x", "nope")).status, 404)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  // A send names the text it took. A save made again (its browser copy, sent as a page
  // closed) answers with the draft as it is now, which may hold another tab's newer text:
  // the send of the older text must leave that text in the draft.
  for (const queued of [false, true]) {
    it.live(`a send never commits newer text a replayed save answered with (${queued ? "queued" : "posted"})`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const chat = yield* api.CreateChat({ title: "Replayed" })
        const tip = queued
          ? (yield* posted(api.Generate({ chatId: chat.id, parentSlotId: null, branch: false }))).entry.slotId
          : null
        const initial = yield* open(api, chat.id, null)
        const save = {
          next: false,
          chatId: chat.id,
          draftId: initial.id,
          rowVersion: initial.rowVersion,
          session: initial.session,
          operationId: "pending-copy",
          content: "alpha"
        }
        const alpha = (yield* api.SaveComposer(save)).draft!
        yield* typeInto(api, chat.id, null, "alpha and more from the other tab", alpha)
        const replayed = (yield* api.SaveComposer(save)).draft!
        assert.strictEqual(replayed.content, "alpha and more from the other tab")
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: tip,
          branch: false,
          content: "alpha",
          composer: takenFrom(initial)
        })
        assert.strictEqual(sent._tag, queued ? "Queued" : "Posted")
        assert.deepStrictEqual(
          [sent.draft?.status, sent.draft?.content],
          ["active", "alpha and more from the other tab"]
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(serverLayer(testConfig(), FakeGenerator.layer({ tokensPerSecond: 1, tokens: 20_000 })))
      )
    )
  }

  it.live("keeps separate composers for two forks at the same message, and a send commits only its own", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Replaced" })
      const root = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "root" })
      )
      const main = root.chat.currentForkId!
      // A fork made at the root, as ST's checkpoint: its tip is the root too.
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: root.entry.slotId })
      assert.strictEqual(fork.tipSlotId, root.entry.slotId)
      const a = yield* typeInto(api, chat.id, main, "tab A unsent")
      const b = yield* typeInto(api, chat.id, fork.id, "tab B distinct text")
      assert.notStrictEqual(a.id, b.id)
      assert.strictEqual((yield* open(api, chat.id, null)).id, b.id)
      // Tab A sends its text in its own fork.
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          forkId: main,
          parentSlotId: root.entry.slotId,
          branch: false,
          content: a.content,
          composer: takenFrom(a)
        })
      )
      assert.deepStrictEqual([sent.draft?.id, sent.draft?.status], [a.id, "committed"])
      // The other fork's composer kept its text, at the message it was made at.
      const there = yield* open(api, chat.id, fork.id)
      assert.deepStrictEqual([there.id, there.content], [b.id, "tab B distinct text"])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
