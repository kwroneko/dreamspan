import { mkdirSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tempDir } from "./support/tempDir.ts"
import { json, stCardV2 } from "./formats/support.ts"
import { cardDoc } from "./support/docs.ts"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { importStPath } from "./support/stUpload.ts"

// Exercise the production worker boundary; source-worker startup was also checked in the initial focused runs.
const layer = () => serverLayer(testConfig({ dbWorkers: "bundle" }), Generator.none)
describe("independent shell reads", () => {
  it.live(
    "orders character activity independently of unrelated chat activity; preserves Created; Recent is the latest activity in any chat the card joined, never a revision",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const a = yield* api.CreateCard({ label: "Aria", name: "Aria" })
        const b = yield* api.CreateCard({ label: "Bryn", name: "Bryn" })
        const versioned = yield* (yield* Writer).CreateEntity({
          userId: (yield* api.Whoami()).id,
          kind: "card",
          label: "Versioned",
          subtitle: "Legacy free subtitle",
          doc: cardDoc("Versioned", { character_version: "2.4" }),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        const start = (cards: ReadonlyArray<typeof a.entityId>) =>
          api.StartChat({
            cards,
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "Start.", speakerEntityId: null }
          })
        const first = yield* start([a.entityId, b.entityId])
        const speak = (
          chatId: typeof first.chat.id,
          parentSlotId: typeof first.chat.activeLeafSlotId,
          speakerEntityId: typeof a.entityId
        ) =>
          posted(
            api.SendMessage({ chatId, parentSlotId, speakerEntityId, content: "A synthetic turn.", branch: false })
          )
        yield* speak(first.chat.id, first.chat.activeLeafSlotId, a.entityId)
        yield* Effect.sleep("5 millis")
        const second = yield* start([a.entityId])
        const secondTurn = yield* speak(second.chat.id, second.chat.activeLeafSlotId, a.entityId)
        yield* Effect.sleep("5 millis")
        const current = yield* api.GetChat({ chatId: first.chat.id })
        yield* speak(first.chat.id, current.activeLeafSlotId, b.entityId)
        const data = yield* api.GetShellLibrary()
        const aria = data.cards.find((c) => c.card.entityId === a.entityId)!
        assert.strictEqual(data.cards.find((c) => c.card.entityId === versioned.entityId)!.card.subtitle, "2.4")
        assert.strictEqual(aria.card.latestChatId, second.chat.id)
        assert.strictEqual(
          data.forks.find((f) => f.chat.id === second.chat.id)!.activity.find((x) => x.entityId === a.entityId)!.slot,
          secondTurn.entry.slotId
        )
        assert.strictEqual(
          data.forks.find((f) => f.chat.id === first.chat.id)!.activity.find((x) => x.entityId === a.entityId)!
            .category,
          "with"
        )
        assert.strictEqual(
          data.forks.find((f) => f.chat.id === second.chat.id)!.activity.find((x) => x.entityId === a.entityId)!
            .category,
          "just"
        )
        yield* api.ChangeCast({
          chatId: first.chat.id,
          slotId: (yield* api.GetChat({ chatId: first.chat.id })).activeLeafSlotId,
          change: { _tag: "Leave", entityId: a.entityId }
        })
        assert.strictEqual(
          (yield* api.GetShellLibrary()).forks
            .find((f) => f.chat.id === first.chat.id)!
            .activity.find((x) => x.entityId === a.entityId)!.category,
          "was"
        )
        assert.strictEqual(
          aria.createdAt,
          (yield* api.GetShellLibrary()).cards.find((c) => c.card.entityId === a.entityId)!.createdAt
        )
        // Aria's latest chat activity is Bryn's turn in the first chat, after her own in the second.
        const latest = Math.max(...data.forks.filter((f) => f.joined.includes(a.entityId)).map((f) => f.recentAt))
        assert.strictEqual(latest, data.forks.find((f) => f.chat.id === first.chat.id)!.recentAt)
        assert.strictEqual(aria.recentAt, latest)
        assert.isNull(data.cards.find((c) => c.card.entityId === versioned.entityId)!.recentAt)
        yield* Effect.sleep("5 millis")
        const me = yield* api.Whoami()
        yield* (yield* Writer).EditRef({
          userId: me.id,
          refId: a.id,
          doc: cardDoc("Aria", { description: "A revised synthetic definition." }),
          expectedRowVersion: a.rowVersion,
          message: "Revision",
          commitDraft: null
        })
        const changed = (yield* api.GetShellLibrary()).cards.find((c) => c.card.entityId === a.entityId)!
        assert.strictEqual(changed.createdAt, aria.createdAt)
        assert.strictEqual(changed.recentAt, aria.recentAt)
      }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("keeps the current fork when browsing and pins a stable fork as it continues", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Fork character", name: "Fork character" })
      const start = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Root", speakerEntityId: null }
      })
      const chatId = start.chat.id
      const first = yield* posted(
        api.SendMessage({
          chatId,
          parentSlotId: start.chat.activeLeafSlotId,
          speakerEntityId: card.entityId,
          content: "First fork",
          branch: false
        })
      )
      yield* api.SetChatPin({ chatId, leaf: first.entry.slotId, pinned: true })
      const second = yield* posted(
        api.SendMessage({
          chatId,
          parentSlotId: start.chat.activeLeafSlotId,
          speakerEntityId: card.entityId,
          content: "Second fork",
          branch: true
        })
      )
      const forksNow = yield* api.ListForks({ chatId })
      yield* api.NameFork({
        forkId: forksNow.find((f) => f.tipSlotId === second.entry.slotId)!.id,
        name: "The other road"
      })
      // Opening the first fork is the client's view alone (no SetActiveLeaf since forks): the current one stays.
      let rows = (yield* api.GetShellLibrary()).forks.filter((f) => f.chat.id === chatId)
      assert.strictEqual(rows.find((f) => f.current)!.leaf, second.entry.slotId)
      assert.strictEqual(rows.find((f) => f.pinned)!.leaf, first.entry.slotId)
      assert.isTrue(rows.find((f) => f.leaf === second.entry.slotId)!.named)
      const continued = yield* posted(
        api.SendMessage({
          chatId,
          // The first fork, opened as the client does: it names its fork.
          forkId: forksNow.find((f) => f.tipSlotId === first.entry.slotId)!.id,
          parentSlotId: first.entry.slotId,
          speakerEntityId: card.entityId,
          content: "Continue the pinned road",
          branch: false
        })
      )
      rows = (yield* api.GetShellLibrary()).forks.filter((f) => f.chat.id === chatId)
      assert.strictEqual(rows.find((f) => f.current)!.leaf, continued.entry.slotId)
      assert.strictEqual(rows.find((f) => f.pinned)!.leaf, continued.entry.slotId)
      yield* api.SetChatPin({ chatId, leaf: continued.entry.slotId, pinned: false })
      assert.isFalse((yield* api.GetShellLibrary()).forks.some((f) => f.pinned))
      yield* api.SetChatPin({ chatId, leaf: continued.entry.slotId, pinned: true })
      const secondFork = (yield* api.ListForks({ chatId })).find((f) => f.tipSlotId === second.entry.slotId)!
      yield* api.DeleteFork({ forkId: secondFork.id })
      assert.strictEqual((yield* api.GetShellLibrary()).forks.find((f) => f.pinned)!.leaf, continued.entry.slotId)
      yield* api.DeleteMessage({ slotId: continued.entry.slotId })
      const afterDelete = (yield* api.GetShellLibrary()).forks.find((f) => f.current)!
      assert.strictEqual(afterDelete.leaf, first.entry.slotId)
      assert.isTrue(afterDelete.pinned)
      yield* api.SetHomePinsCollapsed({ collapsed: true })
      assert.isTrue((yield* api.GetShellLibrary()).pinsCollapsed)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live(
    "lists individual multi-character chats and their current forks, without grouping matching titles or pinning automatically",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const a = yield* api.CreateCard({ label: "One", name: "One" })
        const b = yield* api.CreateCard({ label: "Two", name: "Two" })
        for (let i = 0; i < 2; i++)
          yield* api.StartChat({
            cards: [a.entityId, b.entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "Separate story", speakerEntityId: null }
          })
        const empty = yield* api.CreateChat({ title: "An empty multi-character chat" })
        for (const entityId of [a.entityId, b.entityId])
          yield* api.ChangeCast({ chatId: empty.id, slotId: null, change: { _tag: "Join", entityId } })
        const data = yield* api.GetShellLibrary()
        assert.lengthOf(
          data.forks.filter((f) => f.current && f.cast.length === 2),
          3
        )
        assert.isFalse(data.forks.some((f) => f.pinned))
      }).pipe(Effect.scoped, Effect.provide(layer()))
  )
  it.live(
    "takes folder card creation from ST or file ctime, keeps it on re-import, and uses now for direct uploads",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const folder = tempDir("shell-st-dates")
        mkdirSync(join(folder, "characters"))
        const stored = Date.UTC(2024, 6, 12, 1, 31, 37)
        const source = { ...stCardV2(), create_date: "2024-7-12@01h31m37s" }
        const file = join(folder, "characters", "Wren.json")
        writeFileSync(file, json(source))
        const importFolder = () => importStPath(api, folder)
        yield* importFolder()
        const first = (yield* api.GetShellLibrary()).cards[0]!
        assert.strictEqual(first.createdAt, stored)
        writeFileSync(
          file,
          json({
            ...source,
            create_date: "2025-01-01T00:00:00Z",
            data: { ...source.data, description: "Changed in ST" }
          })
        )
        yield* importFolder()
        assert.strictEqual((yield* api.GetShellLibrary()).cards[0]!.createdAt, stored)
        writeFileSync(
          join(folder, "characters", "Fallback.json"),
          json({ ...source, create_date: "invalid", data: { ...source.data, name: "Fallback" } })
        )
        const fallbackCtime = statSync(join(folder, "characters", "Fallback.json")).ctimeMs
        yield* importFolder()
        assert.closeTo(
          (yield* api.GetShellLibrary()).cards.find((c) => c.card.name === "Fallback")!.createdAt,
          fallbackCtime,
          1
        )
        const port = yield* serverPort
        const before = Date.now()
        yield* Effect.promise(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/library/import?name=Direct.json`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: json({ ...source, data: { ...source.data, name: "Direct" } })
          })
          assert.strictEqual(response.status, 200)
        })
        assert.isAtLeast((yield* api.GetShellLibrary()).cards.find((c) => c.card.name === "Direct")!.createdAt, before)
      }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})
