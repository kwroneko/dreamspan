// The composer's speaker and reply choice on the server (ST-GRIPES D8, DESIGN §2.2): kept
// with its draft, so it moves to the next tip with it, goes along when a branch starts,
// and is published to every tab of the chat. Cross-user access is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import { client, outcome, posted, takenFrom, testConfig, typeInto, withServer } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { eventually } from "./support/generation.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const card = (api: Api, name: string) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const { entityId } = yield* (yield* Writer).CreateEntity({
      userId: me.id as UserId,
      kind: "card",
      label: name,
      subtitle: "",
      doc: cardDoc(name),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    return entityId as EntityId
  })

describe("the composer's choice", () => {
  it.live("is kept with its draft, moves to the next tip, goes along to a branch, and is published", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = yield* card(api, "Ana")
      const bo = yield* card(api, "Bo")
      const mira = yield* card(api, "Mira")
      const chat = yield* api.CreateChat({ title: "Lantern" })
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)

      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const none = yield* api.GetComposerChoice({ chatId: chat.id, draftId: draft.id })
      assert.deepStrictEqual([none.speakerEntityId, none.replyFromEntityId], [null, null])

      const set = yield* api.SetComposerChoice({ chatId: chat.id, draftId: draft.id, speakerEntityId: bo })
      assert.deepStrictEqual([set.speakerEntityId, set.replyFromEntityId], [bo, null])
      // A missing field stays; null clears.
      yield* api.SetComposerChoice({ chatId: chat.id, draftId: draft.id, replyFromEntityId: mira })
      const both = yield* api.GetComposerChoice({ chatId: chat.id, draftId: draft.id })
      assert.deepStrictEqual([both.speakerEntityId, both.replyFromEntityId], [bo, mira])
      yield* eventually(() => events.some((e) => e._tag === "ComposerChoice" && e.choice.replyFromEntityId === mira))
      // The text's row version, which saves name, isn't changed by a choice.
      assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, forkId: null })).rowVersion, draft.rowVersion)

      // Sent: the draft stays with its fork, and its speaker with it.
      const typed = yield* typeInto(api, chat.id, null, "Hello.", draft)
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "Hello.",
          speakerEntityId: bo,
          composer: takenFrom(typed)
        })
      )
      const moved = yield* api.OpenComposer({ chatId: chat.id, forkId: sent.chat.currentForkId })
      assert.strictEqual(moved.id, draft.id)
      assert.strictEqual((yield* api.GetComposerChoice({ chatId: chat.id, draftId: moved.id })).speakerEntityId, bo)

      // A fork from before the first message starts speaking as the composer it came from.
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: null, atSlotId: null })
      const branch = yield* api.OpenComposer({ chatId: chat.id, forkId: fork.id, copyFrom: moved.id })
      assert.notStrictEqual(branch.id, moved.id)
      assert.strictEqual((yield* api.GetComposerChoice({ chatId: chat.id, draftId: branch.id })).speakerEntityId, bo)
      assert.strictEqual(
        (yield* api.GetComposerChoice({ chatId: chat.id, draftId: branch.id })).replyFromEntityId,
        mira
      )
      // ...unless that fork had a speaker of its own.
      yield* api.SetComposerChoice({
        chatId: chat.id,
        draftId: branch.id,
        speakerEntityId: ana,
        replyFromEntityId: null
      })
      yield* api.OpenComposer({ chatId: chat.id, forkId: fork.id, copyFrom: moved.id })
      assert.strictEqual((yield* api.GetComposerChoice({ chatId: chat.id, draftId: branch.id })).speakerEntityId, ana)
      assert.strictEqual(
        (yield* api.GetComposerChoice({ chatId: chat.id, draftId: branch.id })).replyFromEntityId,
        null
      )

      // A send uses its original draft's pick, without erasing a different newer pick.
      yield* api.SetComposerChoice({ chatId: chat.id, draftId: draft.id, replyFromEntityId: ana })
      yield* api.SetComposerChoice({ chatId: chat.id, draftId: draft.id, consumeReplyFromEntityId: mira })
      assert.strictEqual((yield* api.GetComposerChoice({ chatId: chat.id, draftId: draft.id })).replyFromEntityId, ana)
      yield* api.SetComposerChoice({ chatId: chat.id, draftId: draft.id, consumeReplyFromEntityId: ana })
      assert.strictEqual((yield* api.GetComposerChoice({ chatId: chat.id, draftId: draft.id })).replyFromEntityId, null)
      assert.strictEqual((yield* api.GetComposerChoice({ chatId: chat.id, draftId: branch.id })).speakerEntityId, ana)

      // Only the caller's cards, and only drafts of that chat.
      assert.strictEqual(
        yield* outcome(
          api.SetComposerChoice({ chatId: chat.id, draftId: draft.id, speakerEntityId: draft.id as EntityId })
        ),
        "NotFound"
      )
      const other = yield* api.CreateChat({ title: "Elsewhere" })
      assert.strictEqual(yield* outcome(api.GetComposerChoice({ chatId: other.id, draftId: draft.id })), "NotFound")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
