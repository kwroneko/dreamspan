// Notices over a real server (DESIGN §10.1): a reply that ends on its own is news to every
// open tab of its user, and to nobody else; one the user stopped isn't.
import { assert, describe, it } from "@effect/vitest"
import type { Notice } from "@rp/shared/noticeApi.ts"
import { Effect, Stream } from "effect"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import { client, login, posted, serverLayer, testConfig } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const listen = (api: Api) =>
  Effect.gen(function* () {
    const notices: Array<Notice> = []
    yield* api.SubscribeNotices().pipe(
      Stream.runForEach((batch) => Effect.sync(() => notices.push(...batch))),
      Effect.forkScoped
    )
    // The subscription is registered once a later call on the same socket has its answer.
    yield* api.Whoami()
    return notices
  })

const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(10)
    }
  })

describe("notices", () => {
  it.live("tells every tab of the user when a reply finishes, and nobody else", () =>
    Effect.gen(function* () {
      const local = yield* client()
      const admin = yield* local.Whoami()
      yield* local.SetPassword({ userId: admin.id, currentPassword: null, newPassword: "admin-password" })
      const alice = yield* client({ cookie: (yield* login(admin.handle, "admin-password")).cookie })
      yield* alice.CreateUser({ handle: "bob", displayName: "Bob", role: "user", password: "bob-password" })
      const bob = yield* client({ cookie: (yield* login("bob", "bob-password")).cookie })
      const tab = yield* client({ cookie: (yield* login(admin.handle, "admin-password")).cookie })
      const [aliceNotices, tabNotices, bobNotices] = yield* Effect.all([listen(alice), listen(tab), listen(bob)])

      const chat = yield* alice.CreateChat({ title: "Harbor" })
      const sent = yield* posted(
        alice.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "hi" })
      )
      const reply = yield* posted(alice.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      yield* eventually(() => aliceNotices.length > 0 && tabNotices.length > 0)
      assert.deepStrictEqual(aliceNotices, [
        {
          _tag: "ReplyFinished",
          chatId: chat.id,
          slotId: reply.entry.slotId,
          versionId: reply.entry.version.id,
          status: "complete"
        }
      ])
      assert.deepStrictEqual(tabNotices, aliceNotices)
      // Anything for bob would have reached his socket before this answer.
      yield* bob.Whoami()
      assert.deepStrictEqual(bobNotices, [])
    }).pipe(
      Effect.scoped,
      Effect.provide(serverLayer(testConfig(), FakeGenerator.layer({ tokensPerSecond: 3000, tokens: 50 })))
    )
  )

  it.live("says nothing of a reply the user stopped", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const notices = yield* listen(api)
      const chat = yield* api.CreateChat({ title: "Chapel" })
      const sent = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "hi" }))
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      yield* api.StopGeneration({ versionId: reply.entry.version.id })
      // A notice published with the stop would have reached the socket before this answer.
      yield* api.Whoami()
      assert.deepStrictEqual(notices, [])
    }).pipe(
      Effect.scoped,
      Effect.provide(serverLayer(testConfig(), FakeGenerator.layer({ tokensPerSecond: 5, tokens: 20_000 })))
    )
  )
})
