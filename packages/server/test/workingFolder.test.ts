// The workshop's working folder (spec/FILES-AND-ENVIRONMENT.md §2.1–§2.3) at the RPC boundary: the
// folder chip's change (`WorkshopFolder`) stores the folder with its inode on the branch and
// refuses what isn't a folder of the user's Files; a rename made elsewhere is found again by
// inode, a deleted folder is reported gone; the choice is remembered per assistant card and as
// recent, so a new workshop with that card starts there. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider, type Recorded } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"

const call = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    return yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, init))
  })

const json = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

describe("the workshop's working folder", () => {
  it.live("is chosen, found again after a rename, reported gone, and remembered for the card", () =>
    Effect.gen(function* () {
      const api = yield* client()
      assert.strictEqual((yield* json("/files/folder", { path: "/files/thesis" })).status, 200)
      assert.strictEqual((yield* json("/files/folder", { path: "/files/site" })).status, 200)
      const workshop = yield* api.CreateWorkshop({ title: "Folders" })
      const before = yield* api.GetCast({ chatId: workshop.id, slotId: null })
      assert.isUndefined(before.workshopFolder)
      const cardId = before.cards.find((card) => !card.persona)!.entityId

      // Chosen: stored with its inode.
      const cast = yield* api.ChangeCast({
        chatId: workshop.id,
        slotId: null,
        change: { _tag: "WorkshopFolder", path: "/files/thesis" }
      })
      assert.strictEqual(cast.workshopFolder?.path, "/files/thesis")
      assert.isNumber(cast.workshopFolder?.inode)
      // A path that isn't a folder of the user's Files is refused.
      const refused = yield* api
        .ChangeCast({ chatId: workshop.id, slotId: null, change: { _tag: "WorkshopFolder", path: "/files/nope" } })
        .pipe(Effect.flip)
      assert.strictEqual(refused._tag, "NotFound")
      const outside = yield* api
        .ChangeCast({ chatId: workshop.id, slotId: null, change: { _tag: "WorkshopFolder", path: "/etc" } })
        .pipe(Effect.flip)
      assert.strictEqual(outside._tag, "NotFound")

      const stored = cast.workshopFolder!
      const choices = yield* api.WorkshopFolderChoices({ chatId: workshop.id, stored, cardId })
      assert.deepStrictEqual(choices, { current: "/files/thesis", recent: ["/files/thesis"], card: null })

      // Renamed in the app: found by its new path.
      assert.strictEqual((yield* json("/files/move", { from: "/files/thesis", to: "/files/paper" })).status, 200)
      assert.strictEqual(
        (yield* api.WorkshopFolderChoices({ chatId: workshop.id, stored, cardId })).current,
        "/files/paper"
      )

      // Moved in the app into another folder under another name: the branch's stored folder is
      // found through the move, and the card's and recent memory follow it.
      assert.strictEqual((yield* json("/files/folder", { path: "/files/drafts" })).status, 200)
      assert.strictEqual((yield* json("/files/move", { from: "/files/paper", to: "/files/drafts/v2" })).status, 200)
      assert.deepStrictEqual(yield* api.WorkshopFolderChoices({ chatId: workshop.id, stored, cardId }), {
        current: "/files/drafts/v2",
        recent: ["/files/drafts/v2"],
        card: null
      })
      assert.strictEqual((yield* json("/files/move", { from: "/files/drafts", to: "/files/journal" })).status, 200)
      assert.strictEqual(
        (yield* api.WorkshopFolderChoices({ chatId: workshop.id, stored, cardId })).current,
        "/files/journal/v2"
      )
      assert.strictEqual((yield* json("/files/move", { from: "/files/journal/v2", to: "/files/paper" })).status, 200)

      // A new workshop with the same card starts in its remembered folder, where it is now.
      const second = yield* api.CreateWorkshop({ title: "Second", card: cardId })
      const started = yield* api.GetCast({ chatId: second.id, slotId: null })
      assert.strictEqual(started.workshopFolder?.path, "/files/paper")
      assert.strictEqual(
        (yield* api.WorkshopFolderChoices({ chatId: second.id, stored: started.workshopFolder!, cardId })).current,
        "/files/paper"
      )

      // Picking another in the second: the card's folder is offered in the first, where it differs.
      yield* api.ChangeCast({
        chatId: second.id,
        slotId: null,
        change: { _tag: "WorkshopFolder", path: "/files/site" }
      })
      const offered = yield* api.WorkshopFolderChoices({ chatId: workshop.id, stored, cardId })
      assert.strictEqual(offered.card, "/files/site")
      assert.deepStrictEqual(offered.recent, ["/files/site", "/files/paper"])

      // Deleted and made again at the same path: the path is trusted, not the old inode.
      assert.strictEqual((yield* json("/files/delete", { path: "/files/site" })).status, 200)
      assert.strictEqual((yield* json("/files/folder", { path: "/files/site" })).status, 200)
      const site = (yield* api.GetCast({ chatId: second.id, slotId: null })).workshopFolder!
      assert.strictEqual(
        (yield* api.WorkshopFolderChoices({ chatId: second.id, stored: site, cardId })).current,
        "/files/site"
      )

      // Deleted: gone.
      assert.strictEqual((yield* json("/files/delete", { path: "/files/paper" })).status, 200)
      assert.isNull((yield* api.WorkshopFolderChoices({ chatId: workshop.id, stored, cardId })).current)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live(
    "is told to the model in the turn's tail, never in the cached prefix",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((r: Recorded, res) => {
              const body = r.body as unknown as { messages: Array<{ role: string; content?: unknown }> }
              if (JSON.stringify(body.messages).includes("FOLDER TURN")) requests.push(body)
              sse(res, completionChunks(["Noted."], {}))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: { context: 200000 }
        })
        assert.strictEqual((yield* json("/files/folder", { path: "/files/thesis" })).status, 200)
        const chat = yield* api.CreateWorkshop({ title: "Tail" })
        const events: Array<ChatEvent> = []
        yield* api.SubscribeChat({ chatId: chat.id }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        let parent = chat.activeLeafSlotId
        const turn = (content: string) =>
          Effect.gen(function* () {
            const sent = yield* posted(
              api.SendMessage({ chatId: chat.id, parentSlotId: parent, branch: false, content })
            )
            const reply = yield* posted(
              api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
            )
            yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
            parent = reply.entry.slotId
          })
        const text = (m: { content?: unknown }) =>
          typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        // At the top of Files by default.
        yield* turn("FOLDER TURN one")
        // Then in a folder, and in one deleted since (said so, starting at the top).
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: null,
          change: { _tag: "WorkshopFolder", path: "/files/thesis" }
        })
        yield* turn("FOLDER TURN two")
        assert.strictEqual((yield* json("/files/delete", { path: "/files/thesis" })).status, 200)
        yield* turn("FOLDER TURN three")
        assert.strictEqual(requests.length, 3)
        // A workshop carries its run from turn to turn, so the note is told with the turn's own
        // message, and again only on a turn after the folder changed.
        const told = requests.map((r) => r.messages.map(text).filter((t) => t.includes("Working folder:")))
        assert.strictEqual(told[0]!.length, 1)
        assert.match(told[0]![0]!, /Working folder: \/files$/m)
        assert.match(text(requests[0]!.messages.at(-1)!), /Working folder: \/files$/m)
        assert.match(text(requests[1]!.messages.at(-1)!), /^FOLDER TURN two\nWorking folder: \/files\/thesis$/)
        assert.include(
          text(requests[2]!.messages.at(-1)!),
          "FOLDER TURN three\nWorking folder: /files (/files/thesis wasn't found"
        )
        // Each request begins with the one before it: the earlier notes stay where they were told,
        // so the cached prefix never changes, and the system prompt never names the folder.
        for (const [i, request] of requests.entries()) {
          if (i > 0)
            assert.deepStrictEqual(
              request.messages.slice(0, requests[i - 1]!.messages.length).map(text),
              requests[i - 1]!.messages.map(text)
            )
          for (const message of request.messages.filter((m) => m.role === "system"))
            assert.notInclude(text(message), "Working folder:")
        }
        // A turn whose folder didn't change says nothing more.
        yield* turn("FOLDER TURN four")
        assert.strictEqual(text(requests[3]!.messages.at(-1)!), "FOLDER TURN four")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    120_000
  )
})
