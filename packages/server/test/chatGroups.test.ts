// Groups on the home grid (DESIGN §2.1; ST's group tiles): the chats with the same readable
// name and the same characters the user doesn't play, two or more, worked out on the server
// in one read; a group's chats, latest message first; and a chat's own model and preset
// taken off again (`model.unbind`, `preset.unbind`), so it follows the default. Cross-user
// access is in the isolation matrix; the active-path read and chat search at 5,000 chats are
// timed below.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { writeRealisticStFolder } from "./support/stRealistic.ts"
import { importStFolder } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { slowIt } from "./support/slow.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const card = (api: Api, label: string, doc: Partial<CardDoc>, persona = false) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const { entityId } = yield* writer.CreateEntity({
      userId: me.id as UserId,
      kind: "card",
      label,
      subtitle: "",
      doc: cardDoc(label, doc),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    if (persona) yield* writer.SetEntityTags({ userId: me.id as UserId, entityId, tags: ["persona"] })
    return entityId
  })

describe("chat groups", () => {
  it.live("groups chats by name and characters, leaving out the user's own and the bin", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = yield* card(api, "Ana", { name: "Ana", first_mes: "Hi." })
      const mira = yield* card(api, "Mira", { name: "Mira", first_mes: "Hello." })
      const tobin = yield* card(api, "Tobin", { name: "Tobin", first_mes: "Hey." })
      const sam = yield* card(api, "Sam", { name: "Sam" }, true)
      const start = (cards: ReadonlyArray<typeof ana>) =>
        api.StartChat({
          cards,
          persona: sam,
          greeting: null,
          first: { _tag: "Send", content: "Hello.", speakerEntityId: sam }
        })

      const first = yield* start([ana, mira])
      yield* Effect.sleep("5 millis")
      const second = yield* start([ana, mira])
      yield* Effect.sleep("5 millis")
      // One character is no group; a third member is another group.
      yield* start([mira])
      const trio = yield* start([ana, mira, tobin])
      const binned = yield* start([ana, mira])
      yield* api.DeleteChat({ chatId: binned.chat.id })

      const groups = yield* api.ListChatGroups()
      assert.deepStrictEqual(
        groups.map((group) => [group.name, group.chats]),
        [
          // A chat made here is titled by its characters, the persona left out.
          ["Ana & Mira & Tobin", 1],
          ["Ana & Mira", 2]
        ]
      )
      const pair = groups[1]!
      // The persona the user plays isn't a member; the latest chat is the one to continue.
      assert.deepStrictEqual(
        pair.members.map((member) => member.name),
        ["Ana", "Mira"]
      )
      assert.strictEqual(pair.latestChatId, second.chat.id)
      assert.strictEqual(pair.lastMessageAt, second.chat.lastMessageAt)

      const listed = yield* api.ListGroupChats({ chatId: first.chat.id })
      assert.deepStrictEqual(
        listed.chats.map((chat) => chat.id),
        [second.chat.id, first.chat.id]
      )
      assert.strictEqual(listed.group.name, "Ana & Mira")
      assert.strictEqual((yield* api.ListGroupChats({ chatId: trio.chat.id })).chats.length, 1)
      const single = (yield* api.ListChats({ limit: 50, before: null, entityId: mira })).find(
        (chat) => ![first, second, trio].some((made) => made.chat.id === chat.id)
      )!
      const refused = yield* Effect.flip(api.ListGroupChats({ chatId: single.id }))
      assert.strictEqual(refused._tag, "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  slowIt.live(
    "finds a realistic ST folder's groups by their names, among its one-character chats",
    () =>
      Effect.gen(function* () {
        const root = tempDir("st-groups")
        writeRealisticStFolder(root)
        const files = new Map(
          readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => {
              const path = join(entry.parentPath, entry.name)
              return [relative(root, path), new Uint8Array(readFileSync(path))] as const
            })
        )
        yield* importStFolder(files)
        const groups = yield* (yield* client()).ListChatGroups()
        assert.deepStrictEqual(
          Object.fromEntries(groups.map((group) => [group.name, [group.chats, group.members.length]])),
          {
            "The Lantern Inn": [3, 4],
            "Station Kepler": [2, 3],
            "Masquerade at Corvina Hall": [1, 5]
          }
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none))),
    120_000
  )

  it.live("model/preset locks keep chat selections separate from account settings and unlock to the account", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const mira = yield* card(api, "Mira", { name: "Mira", first_mes: "Hello." })
      const started = yield* api.StartChat({
        cards: [mira],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: null }
      })
      const chatId = started.chat.id
      const at = started.entry.slotId
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "local-model", overrides: {} })
      const me = yield* api.Whoami()
      const preset = yield* (yield* Writer).CreateEntity({
        userId: me.id as UserId,
        kind: "preset",
        label: "Long context",
        subtitle: "",
        doc: presetDoc() as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      // DESIGN §2.2 [D] (owner, 2026-11-03, personadefault): a locked
      // selection changes only this chat; unlocking follows the account again.
      const accountModel = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "account-model",
        overrides: {}
      })
      const accountPreset = yield* api.CreatePreset({ label: "Account preset" })
      yield* api.ChangeGenerationDefaults({
        change: { model: { connection: connection.id, model: accountModel.id }, preset: accountPreset.id }
      })
      const defaults = yield* api.GetGenerationDefaults()
      const next = () => api.GetNextContext({ chatId, leafSlotId: at })
      yield* api.ChangeCast({
        chatId,
        slotId: at,
        change: { _tag: "Model", connection: connection.id, model: model.id }
      })
      const bound = yield* api.ChangeCast({
        chatId,
        slotId: at,
        change: { _tag: "Preset", ref: preset.ref.id }
      })
      assert.deepStrictEqual(bound.model, { connection: connection.id, model: model.id })
      assert.strictEqual(bound.preset, preset.ref.id)
      assert.isTrue(bound.presetLocked)
      assert.deepStrictEqual(yield* api.GetGenerationDefaults(), defaults)
      const locked = yield* next()
      assert.strictEqual(locked.model?.model, model.id)
      assert.strictEqual(locked.preset?.ref, preset.ref.id)

      // Changing the account selection leaves both locks in place.
      yield* api.ChangeGenerationDefaults({ change: { preset: null } })
      const stillLocked = yield* next()
      assert.strictEqual(stillLocked.model?.model, model.id)
      assert.strictEqual(stillLocked.preset?.ref, preset.ref.id)
      const currentDefaults = yield* api.GetGenerationDefaults()
      yield* api.ChangeCast({ chatId, slotId: at, change: { _tag: "DefaultModel" } })
      const cleared = yield* api.ChangeCast({ chatId, slotId: at, change: { _tag: "DefaultPreset" } })
      assert.isNull(cleared.model)
      assert.isNull(cleared.preset)
      assert.isFalse(cleared.presetLocked)
      assert.deepStrictEqual(yield* api.GetGenerationDefaults(), currentDefaults)
      const following = yield* next()
      assert.strictEqual(following.model?.model, accountModel.id)
      assert.isNull(following.preset?.ref)
      assert.isTrue(following.budget?.builtinPreset)
      // Locks are positional; the state before the locked position is unchanged.
      const before = yield* api.GetCast({ chatId, slotId: null })
      assert.isNull(before.model)
      assert.isNull(before.preset)
      assert.isFalse(before.presetLocked)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

describe("groups at the active leaf", () => {
  it.live("restoring played-by-me to empty restores both characters on the group tile", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      const mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const chat = yield* api.CreateChat({ title: "Two characters" })
      for (const entityId of [ana, mira])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [ana] } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [] } })
      const cast = yield* api.GetCast({ chatId: chat.id, slotId: null })
      assert.deepStrictEqual(cast.playedByMe, [])
      const groups = yield* api.ListChatGroups()
      assert.lengthOf(groups, 1, "both characters now belong on a group tile")
      assert.deepStrictEqual(
        groups[0]!.members.map((m) => m.entityId),
        [ana, mira]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("leaving a two-character chat removes its group tile", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      const mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const chat = yield* api.CreateChat({ title: "Former group" })
      for (const entityId of [ana, mira])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Leave", entityId: mira } })
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, slotId: null })).participants, [ana])
      assert.lengthOf(yield* api.ListChatGroups(), 0, "one current character is not a group")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("joining on a sibling branch does not put the sibling-only member in the active group", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      const mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const tobin = (yield* api.CreateCard({ label: "Tobin", name: "Tobin" })).entityId
      const chat = yield* api.CreateChat({ title: "Branch group" })
      for (const entityId of [ana, mira])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      const root = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Root." })
      assert.strictEqual(root._tag, "Posted")
      if (root._tag !== "Posted") return
      const sibling = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: root.entry.slotId,
        branch: false,
        content: "Sibling."
      })
      assert.strictEqual(sibling._tag, "Posted")
      if (sibling._tag !== "Posted") return
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: sibling.entry.slotId,
        change: { _tag: "Join", entityId: tobin }
      })
      const active = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: root.entry.slotId,
        branch: true,
        content: "Active."
      })
      assert.strictEqual(active._tag, "Posted")
      if (active._tag !== "Posted") return
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, slotId: active.entry.slotId })).participants, [
        ana,
        mira
      ])
      const group = (yield* api.ListChatGroups())[0]!
      assert.deepStrictEqual(
        group.members.map((m) => m.entityId),
        [ana, mira]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

describe("group played characters", () => {
  it.live("includes a persona-tagged participant when the user no longer plays it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = yield* card(api, "Ana", { name: "Ana" })
      const sam = yield* card(api, "Sam", { name: "Sam" }, true)
      const chat = yield* api.CreateChat({ title: "Shared cast" })
      for (const entityId of [ana, sam])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [sam] } })
      assert.lengthOf(yield* api.ListChatGroups(), 0)
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [] } })
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, slotId: null })).participants, [ana, sam])
      const groups = yield* api.ListChatGroups()
      assert.lengthOf(groups, 1)
      assert.deepStrictEqual(
        groups[0]!.members.map((member) => member.entityId),
        [ana, sam]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

describe("group event validity", () => {
  it.live("matches GetCast when a version is unselected or its ancestor message is deleted and restored", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      const mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const tobin = (yield* api.CreateCard({ label: "Tobin", name: "Tobin" })).entityId
      const chat = yield* api.CreateChat({ title: "Selected cast" })
      for (const entityId of [ana, mira])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      const root = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Root" })
      if (root._tag !== "Posted") throw new Error("unexpected queue")
      const me = yield* api.Whoami()
      yield* (yield* Writer).AddStateEvent({
        userId: me.id as UserId,
        chatId: chat.id,
        slotId: root.entry.slotId,
        versionId: root.entry.version.id,
        scope: null,
        data: { key: "participant.join", value: { entity: tobin } }
      })
      const check = (slotId: typeof root.entry.slotId, expected: ReadonlyArray<typeof ana>) =>
        Effect.gen(function* () {
          const cast = yield* api.GetCast({ chatId: chat.id, slotId })
          assert.deepStrictEqual(cast.participants, expected)
          const group = (yield* api.ListChatGroups())[0]!
          assert.deepStrictEqual(
            group.members.map((member) => member.entityId),
            expected
          )
        })
      yield* check(root.entry.slotId, [ana, mira, tobin])
      const alternate = yield* api.WriteVersion({
        slotId: root.entry.slotId,
        content: "Alternate",
        expectedRowVersion: root.entry.rowVersion
      })
      yield* check(root.entry.slotId, [ana, mira])
      yield* api.SelectVersion({
        slotId: root.entry.slotId,
        versionId: root.entry.version.id,
        expectedVersionId: alternate.version.id
      })
      const leaf = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: root.entry.slotId,
        branch: false,
        content: "Leaf"
      })
      if (leaf._tag !== "Posted") throw new Error("unexpected queue")
      yield* check(leaf.entry.slotId, [ana, mira, tobin])
      const deleted = yield* api.DeleteMessage({ slotId: root.entry.slotId })
      yield* check(leaf.entry.slotId, [ana, mira])
      yield* api.RestoreBinItem({ itemId: deleted.id })
      yield* check(leaf.entry.slotId, [ana, mira, tobin])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

describe("group read scale", () => {
  slowIt.live("groups and searches 5,000 active ten-message paths within the read budget", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      const now = Date.now()
      // Written straight into the file: 5,000 chats through the RPCs would take minutes.
      const series = (n: number) => `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${n - 1})`
      const doc = `json_object('name', 'Card ' || i, 'description', printf('%.4000c', 'x'), 'first_mes', 'Hello.')`
      yield* fixtureSql(config.dataDir, [
        {
          sql: `INSERT INTO entities (id, owner_user_id, kind, created_at) ${series(1000)}
            SELECT printf('e-%04d', i), ?, 'card', ? FROM n`,
          params: [me.id, now]
        },
        {
          sql: `INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
            ${series(1000)} SELECT printf('v-%04d', i), printf('e-%04d', i), ${doc}, 'h' || i, 1, 'import', ? FROM n`,
          params: [now]
        },
        {
          sql: `INSERT INTO entity_refs (id, entity_id, ref_kind, head_revision_id, label, created_at, updated_at)
            ${series(1000)} SELECT printf('r-%04d', i), printf('e-%04d', i), 'upstream', printf('v-%04d', i),
              'Card ' || i, ?, ? FROM n`,
          params: [now, now]
        },
        {
          sql: `INSERT INTO chats (id, owner_user_id, kind, status, title, created_at, last_message_at) ${series(5000)}
            SELECT printf('c-%05d', i), ?, 'rp', 'active', 'Chat ' || i, ?, ? + i FROM n`,
          params: [me.id, now, now]
        },
        // Two cards a chat, every third chat a group of three, and other settings around them.
        {
          sql: `INSERT INTO state_events (id, chat_id, seq, key, value_json, origin, created_at) ${series(5000)}
            SELECT printf('s-%05d-%d', i, k.k), printf('c-%05d', i), k.k,
              CASE WHEN k.k < 3 THEN 'participant.join' ELSE 'model.binding' END,
              CASE WHEN k.k < 3 THEN json_object('entity', printf('e-%04d', (i * (k.k + 1) * 7) % 800))
                ELSE json_object('connection', 'x', 'model', 'y') END,
              'import', ?
            FROM n JOIN (SELECT 0 AS k UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) k
            WHERE k.k <> 2 OR i % 3 = 0`,
          params: [now]
        },
        {
          sql: `INSERT INTO versions (id, slot_id, ordinal, status, writer, macro_mode, origin, created_at, updated_at)
            ${series(5000)}, depths(d) AS (SELECT 0 UNION ALL SELECT d + 1 FROM depths WHERE d < 9)
            SELECT 'v-slot-' || i || '-' || d, 'slot-' || i || '-' || d, 0, 'complete', 'human', 'verbatim', 'imported', ?, ? FROM n, depths`,
          params: [now, now]
        },
        {
          sql: `INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at)
            ${series(5000)}, depths(d) AS (SELECT 0 UNION ALL SELECT d + 1 FROM depths WHERE d < 9)
            SELECT 'slot-' || i || '-' || d, printf('c-%05d', i),
              CASE WHEN d = 0 THEN NULL ELSE 'slot-' || i || '-' || (d - 1) END, d, 'v-slot-' || i || '-' || d, ? FROM n, depths ORDER BY d, i`,
          params: [now]
        },
        { sql: "UPDATE chats SET active_leaf_slot_id = 'slot-' || CAST(substr(id, 3) AS INTEGER) || '-9'" },
        {
          sql: `INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, created_at)
            ${series(5000)} SELECT 'played-' || i || '-' || k, printf('c-%05d', i), 'slot-' || i || '-9', k,
              'played_by_me.set', CASE WHEN k = 0 THEN json_object('entities', json_array(printf('e-%04d', i * 7 % 800))) ELSE json_object('entities', json_array()) END, 'import', ? FROM n JOIN (SELECT 0 AS k UNION ALL SELECT 1)`,
          params: [now]
        }
      ])
      // The groups (two or three characters a chat, each chat titled apart): one read too.
      yield* api.ListChatGroups()
      const groupsStarted = performance.now()
      const groups = yield* api.ListChatGroups()
      const groupsTook = performance.now() - groupsStarted
      assert.strictEqual(
        groups.reduce((sum, group) => sum + group.chats, 0),
        [...Array(5000).keys()].filter((i) => distinctCards(i) >= 2).length
      )
      process.stdout.write(`ListChatGroups: 5,000 active ten-message paths in ${groupsTook.toFixed(0)} ms\n`)
      assert.isBelow(groupsTook, 2000)
      // Search resolves the cast only for chats a card in them could match: a search that
      // matches nothing mustn't resolve all 5,000.
      for (const [search, hits] of [
        ["Card 1", 50],
        ["no-such-name", 0]
      ] as const) {
        yield* api.ListChats({ limit: 50, before: null, search })
        const searchStarted = performance.now()
        const found = yield* api.ListChats({ limit: 50, before: null, search })
        const searchTook = performance.now() - searchStarted
        assert.strictEqual(found.length, hits)
        process.stdout.write(`ListChats search ${JSON.stringify(search)}: 5,000 chats in ${searchTook.toFixed(0)} ms\n`)
        assert.isBelow(searchTook, 500)
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
})

/** The cards fixture chat `i` names, each once (the read counts distinct chats). */
const distinctCards = (i: number) =>
  new Set([0, 1, ...(i % 3 === 0 ? [2] : [])].map((k) => (i * (k + 1) * 7) % 800)).size
