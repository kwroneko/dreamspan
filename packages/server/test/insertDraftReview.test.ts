import { assert, describe, it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = (yield* api.Whoami()).id
  const chat = yield* api.CreateChat({ title: "Synthetic draft boundaries" })
  const forkId = chat.currentForkId!
  const append = (parentSlotId: SlotId | null, generating = false) =>
    writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId,
      parentSlotId,
      branch: false,
      commitDraft: null,
      version: new NewVersion({
        speakerEntityId: null,
        writer: generating ? "model" : "human",
        status: generating ? "generating" : "complete",
        content: generating ? "" : "Anchor",
        macroMode: "verbatim",
        origin: generating ? "generated" : "user_written"
      })
    })
  const a = yield* append(null)
  const b = yield* append(a.slotId)
  const other = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: forkId, atSlotId: b.slotId })).fork.id
  const save = (anchor: SlotId, fork = forkId) =>
    api.SaveMessageDraft({
      target: { _tag: "Insert", chatId: chat.id, forkId: fork, anchor },
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: "Same text"
    })
  const read = (id: string) => Effect.map(api.MessageDrafts({ chatId: chat.id }), (ds) => ds.find((d) => d.id === id))
  return { api, writer, reader, userId, chat, forkId, a, b, other, save, read, append }
})

describe("insert draft commit boundaries", () => {
  for (const queued of [false, true])
    for (const kind of ["message", "generate"] as const) {
      it.live(`${queued ? "queued" : "posted"} ${kind} commits only its own insertion draft`, () =>
        Effect.gen(function* () {
          for (const source of ["anchor", "fork", "own"] as const) {
            const h = yield* setup
            const tip = queued ? (yield* h.append(h.b.slotId, true)).slotId : h.b.slotId
            const draft = yield* h.save(source === "anchor" ? h.a.slotId : tip, source === "fork" ? h.other : h.forkId)
            const result = yield* h.writer.SendOrQueue({
              userId: h.userId,
              chatId: h.chat.id,
              forkId: h.forkId,
              parentSlotId: tip,
              branch: false,
              kind,
              content: "Same text",
              direction: "Same text",
              speakerEntityId: null,
              replySpeakerEntityId: null,
              noReply: true,
              commitDraft: { draftId: draft.id, session: draft.session }
            })
            assert.strictEqual(result._tag, queued ? "Queued" : "Posted")
            const kept = yield* h.read(draft.id)
            if (source === "own") assert.isUndefined(kept)
            else assert.strictEqual(kept?.content, "Same text")
          }
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
      )
    }

  it.live("neither append nor queue commits another fork's composer draft", () =>
    Effect.gen(function* () {
      for (const queued of [false, true]) {
        const h = yield* setup
        const tip = queued ? (yield* h.append(h.b.slotId, true)).slotId : h.b.slotId
        const opened = yield* h.api.OpenComposer({ chatId: h.chat.id, forkId: h.other })
        const saved = yield* h.api.SaveComposer({
          chatId: h.chat.id,
          draftId: opened.id,
          rowVersion: opened.rowVersion,
          session: opened.session,
          content: "Same text",
          next: false,
          operationId: crypto.randomUUID()
        })
        yield* h.writer.SendOrQueue({
          userId: h.userId,
          chatId: h.chat.id,
          forkId: h.forkId,
          parentSlotId: tip,
          branch: false,
          kind: "message",
          content: "Same text",
          direction: null,
          speakerEntityId: null,
          replySpeakerEntityId: null,
          noReply: true,
          commitDraft: { draftId: saved.draft!.id, session: saved.draft!.session }
        })
        const kept = yield* h.api.OpenComposer({ chatId: h.chat.id, forkId: h.other })
        assert.strictEqual(kept.content, "Same text")
        assert.strictEqual(kept.status, "active")
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("inserting commits only the draft for that fork and anchor", () =>
    Effect.gen(function* () {
      const h = yield* setup
      for (const draft of [yield* h.save(h.b.slotId), yield* h.save(h.a.slotId, h.other), yield* h.save(h.a.slotId)]) {
        const correct = draft.key.field === `${h.forkId}:${h.a.slotId}`
        yield* h.api.InsertMessage({
          chatId: h.chat.id,
          forkId: h.forkId,
          anchor: h.a.slotId,
          expectedRowVersion: 0,
          body: {
            _tag: "Write",
            speaker: null,
            content: "Same text",
            draft: { draftId: draft.id, session: draft.session }
          }
        })
        const kept = yield* h.read(draft.id)
        if (correct) assert.isUndefined(kept)
        else assert.strictEqual(kept?.content, "Same text")
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
