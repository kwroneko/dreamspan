// The workshop's working folder (spec/FILES-AND-ENVIRONMENT.md §2.1–§2.3) at the RPC boundary: the
// folder chip's change (`WorkshopFolder`) stores the folder with its inode on the branch and
// refuses what isn't a folder of the user's Files; a rename made elsewhere is found again by
// inode, a deleted folder is reported gone; the choice is remembered per assistant card and as
// recent, so a new workshop with that card starts there. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"

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

      // Renamed elsewhere: found by its inode.
      assert.strictEqual((yield* json("/files/move", { from: "/files/thesis", to: "/files/paper" })).status, 200)
      assert.strictEqual(
        (yield* api.WorkshopFolderChoices({ chatId: workshop.id, stored, cardId })).current,
        "/files/paper"
      )

      // A new workshop with the same card starts in its remembered folder.
      const second = yield* api.CreateWorkshop({ title: "Second", card: cardId })
      const started = yield* api.GetCast({ chatId: second.id, slotId: null })
      assert.strictEqual(started.workshopFolder?.path, "/files/thesis")
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
      assert.deepStrictEqual(offered.recent, ["/files/site", "/files/thesis"])

      // Deleted: gone.
      assert.strictEqual((yield* json("/files/delete", { path: "/files/paper" })).status, 200)
      assert.isNull((yield* api.WorkshopFolderChoices({ chatId: workshop.id, stored, cardId })).current)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
