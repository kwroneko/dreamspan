// Who was present, recorded with each message (spec/CHARACTER-CONTEXT.md §9.1, unit C2): a
// version keeps who of its cast was away and who narrated when it was written, a reply as it
// was assembled, a written message as the cast stood; Mute alone records nothing; a merge
// copies who knew each source message. Through a real server and a mock provider.
import { assert, describe, it } from "@effect/vitest"
import {
  type ChatId,
  type EntityId,
  type ForkId,
  NewVersion,
  type SlotId,
  type VersionId
} from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { AWAY_ACTS_AS_MUTED } from "@dreamspan/shared/knowledge.ts"
import type { StateEventData } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import { Generator } from "../src/chat/Generator.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

/** A version's stored presence record and snapshot inputs, read straight from the file. */
const stored = (dataDir: string, versionId: string) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    const row = db
      .prepare(
        `SELECT v.presence_json AS presence, v.cast_json AS cast, p.context_snapshot_json AS snapshot
         FROM version_records v LEFT JOIN rollout_payloads p ON p.rollout_id = v.rollout_id WHERE v.id = ?`
      )
      .get(versionId) as { presence: string | null; cast: string | null; snapshot: string | null }
    return {
      presence: row.presence === null ? null : (JSON.parse(row.presence) as unknown),
      cast: row.cast === null ? null : (JSON.parse(row.cast) as Array<string>),
      inputs: row.snapshot === null ? null : (JSON.parse(row.snapshot) as { inputs: Record<string, unknown> }).inputs
    }
  } finally {
    db.close()
  }
}

const mockProvider = Effect.acquireRelease(
  Effect.promise(() =>
    startMockProvider((_request, res) =>
      sse(res, completionChunks(["The ledger says otherwise."], { prompt_tokens: 10, completion_tokens: 4 }))
    )
  ),
  (m) => Effect.promise(() => m.close())
)

/** A reply generated with Wren in the cast, after the given chat-wide events about Wren. */
const replyWith = (dataDir: string, about: (wren: EntityId) => ReadonlyArray<StateEventData>, muted = false) =>
  Effect.gen(function* () {
    const mock = yield* mockProvider
    const api = yield* client()
    const userId = (yield* api.Whoami()).id as UserId
    const made = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      characters: ["Wren"],
      ...(muted ? { muted: ["Wren"] } : {}),
      before: (chat, [wren]) =>
        Effect.gen(function* () {
          const writer = yield* Writer
          for (const data of about(wren!))
            yield* writer.AddStateEvent({ userId, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
        })
    })
    const wren = made.characters[0]!.entityId as EntityId
    return {
      wren,
      mira: made.mira.entityId as EntityId,
      reply: stored(dataDir, made.version.id),
      sent: stored(dataDir, made.sent.version.id),
      request: JSON.stringify(mock.requests().at(-1)!.body)
    }
  })

describe("presence recorded with each message", () => {
  it.live("a reply and the message before it record who was away; the request is unchanged", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const away = yield* replyWith(config.dataDir, (wren) => [
        { key: "away.set", value: { entity: wren, away: true } }
      ])
      assert.deepStrictEqual(away.reply.presence, { away: [away.wren] })
      assert.deepStrictEqual(
        away.reply.inputs?.presence,
        { away: [away.wren] },
        "the snapshot keeps what was assembled"
      )
      assert.include(away.reply.cast!, away.wren, "an away character is still in the cast")
      assert.deepStrictEqual(away.sent.presence, { away: [away.wren] }, "a written message records it too")

      // Away changes nothing that's sent in a shared context, and a chat without it stores nothing.
      const plain = yield* replyWith(config.dataDir, () => [])
      assert.isNull(plain.reply.presence)
      assert.isNull(plain.sent.presence)
      assert.notProperty(plain.reply.inputs!, "presence", "the snapshot has no presence key without one")
      assert.strictEqual(away.request, plain.request)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("Mute alone records nothing; a narrator is recorded and never away", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const muted = yield* replyWith(config.dataDir, () => [], true)
      assert.isNull(muted.reply.presence, "a muted character was there")
      assert.isNull(muted.sent.presence)

      const narrated = yield* replyWith(config.dataDir, (wren) => [
        { key: "cast.role", value: { entity: wren, role: "narrator" } },
        { key: "away.set", value: { entity: wren, away: true } }
      ])
      assert.deepStrictEqual(narrated.reply.presence, { narrators: [narrated.wren] })
      assert.deepStrictEqual(narrated.sent.presence, { narrators: [narrated.wren] })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("away for turn picking and notes (unit C8)", () => {
  /** A reply with Wren in the cast and a note "while Wren isn't muted", after `about` Wren. */
  const withNote = (about: (wren: EntityId) => ReadonlyArray<StateEventData>) =>
    Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const userId = (yield* api.Whoami()).id as UserId
      const made = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: ["Wren"],
        before: (chat, [wren]) =>
          Effect.gen(function* () {
            const writer = yield* Writer
            const add = (data: StateEventData) =>
              writer.AddStateEvent({ userId, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
            const note = yield* writer.CreateEntity({
              userId,
              kind: "note",
              label: "Lantern",
              subtitle: "",
              doc: {
                schema_version: 1,
                title: "Lantern",
                content: "Wren carries the lantern.",
                owner: { chat: chat.id },
                placement: { mode: "tail", role: "system" },
                exportable: false,
                condition: { when: "not_muted", cards: [wren!] }
              } as never,
              schemaVersion: 1,
              origin: "user",
              sourcePath: null
            })
            yield* add({ key: "note.activate", value: { note: note.entityId } })
            for (const data of about(wren!)) yield* add(data)
          })
      })
      const cast = yield* api.GetCast({ chatId: made.chat.id, slotId: null })
      return { request: JSON.stringify(mock.requests().at(-1)!.body), cast, wren: made.characters[0]!.entityId }
    })

  it.live("GetCast carries who's away and the roles; away counts as muted for a note's condition", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const plain = yield* withNote(() => [])
      assert.include(plain.request, "Wren carries the lantern.")
      assert.notProperty(plain.cast, "away")
      assert.notProperty(plain.cast, "roles")

      const away = yield* withNote((wren) => [{ key: "away.set", value: { entity: wren, away: true } }])
      if (AWAY_ACTS_AS_MUTED) assert.notInclude(away.request, "Wren carries the lantern.", "AWAY_ACTS_AS_MUTED")
      else assert.include(away.request, "Wren carries the lantern.", "AWAY_ACTS_AS_MUTED")
      assert.deepStrictEqual(away.cast.away, [away.wren])
      assert.deepStrictEqual(away.cast.absent, [], "away isn't Mute")

      // A narrator is never away: left out of `away`, its role carried.
      const narrated = yield* withNote((wren) => [
        { key: "cast.role", value: { entity: wren, role: "narrator" } },
        { key: "away.set", value: { entity: wren, away: true } }
      ])
      assert.notProperty(narrated.cast, "away")
      assert.deepStrictEqual(narrated.cast.roles, { [narrated.wren]: "narrator" })
      assert.include(narrated.request, "Wren carries the lantern.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("presence on written messages, swipes, copies and merges", () => {
  const setup = Effect.gen(function* () {
    const api = yield* client()
    const reader = yield* Reader
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const card = (name: string) =>
      Effect.map(
        writer.CreateEntity({
          userId,
          kind: "card",
          label: name,
          subtitle: "",
          doc: cardDoc(name),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        }),
        (made) => made.entityId as EntityId
      )
    const mira = yield* card("Mira")
    const kai = yield* card("Kai")
    const chat = (title: string, cast: ReadonlyArray<EntityId>) =>
      Effect.map(
        writer.CreateChat({ userId, kind: "rp", status: "active", title, participants: cast, greeting: null }),
        (made) => ({ chatId: made.id as ChatId, forkId: made.currentForkId! as ForkId })
      )
    const said = (speaker: EntityId, content: string) =>
      new NewVersion({
        speakerEntityId: speaker,
        writer: "human",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      })
    const append = (at: { chatId: ChatId; forkId: ForkId }, parent: SlotId | null, speaker: EntityId, text: string) =>
      writer.AppendMessage({
        userId,
        chatId: at.chatId,
        forkId: at.forkId,
        parentSlotId: parent,
        branch: false,
        version: said(speaker, text),
        commitDraft: null
      })
    const away = (at: { chatId: ChatId; forkId: ForkId }, slotId: SlotId, entity: EntityId, isAway: boolean) =>
      writer.AddStateEvent({
        userId,
        chatId: at.chatId,
        forkId: at.forkId,
        slotId,
        versionId: null,
        scope: null,
        data: { key: "away.set", value: { entity, away: isAway } }
      })
    return { api, reader, writer, userId, mira, kai, chat, said, append, away }
  })

  it.live("each version records the position it was written at, and a merge copies who knew each message", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const t = yield* setup
      const docks = yield* t.chat("Docks", [t.kai, t.mira])
      const d1 = yield* t.append(docks, null, t.kai, "d1")
      yield* t.away(docks, d1.slotId, t.mira, true)
      const d2 = yield* t.append(docks, d1.slotId, t.kai, "d2")
      assert.isNull(stored(config.dataDir, d1.version.id).presence, "written before Mira left")
      assert.deepStrictEqual(stored(config.dataDir, d2.version.id).presence, { away: [t.mira] })

      // A swipe at d1 is written at d1's position, before the away mark; one at d2 after it.
      const early = yield* t.writer.AddVersion({
        userId: t.userId,
        slotId: d1.slotId,
        forkId: docks.forkId,
        version: t.said(t.kai, "d1 again"),
        select: false,
        commitDraft: null
      })
      assert.isNull(stored(config.dataDir, early.id).presence)
      const late = yield* t.writer.AddVersion({
        userId: t.userId,
        slotId: d2.slotId,
        forkId: docks.forkId,
        version: t.said(t.kai, "d2 again"),
        select: false,
        commitDraft: null
      })
      assert.deepStrictEqual(stored(config.dataDir, late.id).presence, { away: [t.mira] })

      // A duplicate takes the record of where it's put, as it takes that cast.
      const copy = yield* t.writer.InsertMessage({
        userId: t.userId,
        chatId: docks.chatId,
        forkId: docks.forkId,
        anchorSlotId: d2.slotId,
        expectedRowVersion: 0,
        body: { _tag: "Duplicate", versionId: d2.version.id as VersionId }
      })
      assert.deepStrictEqual(stored(config.dataDir, copy.version.id).presence, { away: [t.mira] })

      // Back again: the next message records nobody away.
      yield* t.away(docks, d2.slotId, t.mira, false)
      const d3 = yield* t.append(docks, d2.slotId, t.kai, "d3")
      assert.isNull(stored(config.dataDir, d3.version.id).presence)

      // Merged into another chat, each copied message keeps who knew it in the source.
      const harbor = yield* t.chat("Harbor", [t.mira])
      yield* t.append(harbor, null, t.mira, "h1")
      const request = { ...harbor, at: null, source: docks }
      const seen = yield* t.reader.PreviewChatMerge({ userId: t.userId, includeLeftOut: false, ...request })
      yield* t.writer.MergeChat({
        userId: t.userId,
        includeLeftOut: false,
        ...request,
        title: seen.sourceTitle,
        framing: null,
        digest: seen.digest
      })
      const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      const rows = db
        .prepare("SELECT content, knowers_json AS knowers FROM chat_merge_messages ORDER BY ordinal")
        .all() as Array<{ content: string; knowers: string | null }>
      db.close()
      assert.deepStrictEqual(
        rows.map((r) => [r.content, JSON.parse(r.knowers!) as Array<string>]),
        [
          ["d1", [t.kai, t.mira]],
          ["d2", [t.kai]],
          ["d2", [t.kai]],
          ["d3", [t.kai, t.mira]]
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
})
