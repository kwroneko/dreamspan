// Notices over a real server (DESIGN §10.1): a reply that ends on its own is news to every
// open tab of its user, and to nobody else; one the user stopped isn't.
import { assert, describe, it } from "@effect/vitest"
import type { Notice } from "@dreamspan/shared/noticeApi.ts"
import { Effect, Queue, Stream } from "effect"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Notices } from "../src/chat/Notices.ts"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import { client, login, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const listen = (api: Api) =>
  Effect.gen(function* () {
    const notices: Array<Notice> = []
    yield* api.SubscribeNotices().pipe(
      Stream.runForEach((batch) =>
        Effect.sync(() => notices.push(...batch.filter((notice) => notice._tag === "ReplyFinished")))
      ),
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

it.live("private draft saves, restores, endings and closing-page writes notify only their account", () =>
  Effect.gen(function* () {
    const local = yield* client()
    const user = yield* local.Whoami()
    yield* local.SetPassword({ userId: user.id, currentPassword: null, newPassword: "draft-password" })
    const session = yield* login(user.handle, "draft-password")
    const api = yield* client({ cookie: session.cookie })
    yield* api.CreateUser({ handle: "draft-other", displayName: "Other", role: "user", password: "other-password" })
    const tab = yield* client({ cookie: session.cookie })
    const other = yield* client({ cookie: (yield* login("draft-other", "other-password")).cookie })
    const notices: Array<Notice> = []
    const otherNotices: Array<Notice> = []
    for (const [connection, received] of [
      [tab, notices],
      [other, otherNotices]
    ] as const)
      yield* connection.SubscribeNotices().pipe(
        Stream.runForEach((batch) => Effect.sync(() => received.push(...batch))),
        Effect.forkScoped
      )
    yield* eventually(
      () => notices.some((n) => n._tag === "UserDraftSync") && otherNotices.some((n) => n._tag === "UserDraftSync")
    )
    const address = { ownerId: user.id, targetId: "Settings → Chats", field: "Summarization instruction" }
    const initial = yield* api.SaveUserDraft({
      ...address,
      content: "Starting synthetic text",
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null
    })
    const next = yield* api.SaveUserDraft({
      ...address,
      content: "Other device's draft",
      draftId: initial.id,
      expectedRowVersion: initial.rowVersion,
      expectedSession: initial.session
    })
    const history = yield* api.UserDraftHistory(address)
    const restored = yield* api.RestoreUserDraft({
      ...address,
      draftId: initial.id,
      expectedRowVersion: next.rowVersion,
      seq: history.at(-1)!.seq
    })
    const ended = yield* api.EndUserDraft({
      ...address,
      draftId: initial.id,
      expectedRowVersion: restored.rowVersion,
      outcome: "discarded"
    })
    yield* eventually(() => notices.filter((n) => n._tag === "UserDraftChanged").length === 4)
    assert.isTrue(notices.some((n) => n._tag === "UserDraftChanged" && n.draft.content === "Other device's draft"))
    assert.isTrue(notices.some((n) => n._tag === "UserDraftChanged" && n.draft.status === "discarded"))
    const port = yield* serverPort
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/library/drafts`, {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          drafts: [],
          userDrafts: [
            { ...address, content: "Closing page text", draftId: null, expectedRowVersion: null, expectedSession: null }
          ]
        })
      })
    )
    assert.strictEqual(response.status, 204)
    // A closing-page copy from before deletion is recovered, never put back in the field.
    assert.strictEqual(response.headers.get("x-drafts-recovered"), "1")
    yield* eventually(() => notices.some((n) => n._tag === "UserDraftChanged" && n.draft.recovered > 0))
    assert.strictEqual((yield* api.GetUserDraft(address))?.content, "")
    // New typing after observing that deletion is a valid closing-page save and notifies too.
    const fresh = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/library/drafts`, {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          drafts: [],
          userDrafts: [
            {
              ...address,
              content: "Closing page text",
              draftId: ended.id,
              expectedRowVersion: ended.rowVersion,
              expectedSession: ended.session
            }
          ]
        })
      })
    )
    assert.strictEqual(fresh.status, 204)
    yield* eventually(() =>
      notices.some((n) => n._tag === "UserDraftChanged" && n.draft.content === "Closing page text")
    )
    yield* other.Whoami()
    assert.isFalse(otherNotices.some((n) => n._tag === "UserDraftChanged"))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)

it.effect("an overflowing notice subscription requests a private-draft resync", () =>
  Effect.gen(function* () {
    const notices = yield* Notices
    const owner = "synthetic-owner" as UserId
    const queue = yield* notices.subscribe(owner)
    const notice = {
      _tag: "ReplyFinished",
      chatId: "synthetic-chat",
      slotId: "synthetic-slot",
      versionId: "synthetic-version",
      status: "complete"
    } as Notice
    for (let i = 0; i < 257; i++) notices.publish(owner, notice)
    const batch = yield* Queue.take(queue)
    assert.deepStrictEqual(batch, [{ _tag: "UserDraftSync" }, notice])
  }).pipe(Effect.scoped, Effect.provide(Notices.layer))
)
