import { assert, it } from "@effect/vitest"
import { type EntityId, NewVersion } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live("a handwritten swipe records presence after preceding insertions, only on the fork showing them", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const mira = yield* writer.CreateEntity({
      userId,
      kind: "card",
      label: "Mira",
      subtitle: "",
      doc: cardDoc("Mira"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Insertions",
      participants: [mira.entityId as EntityId],
      greeting: null
    })
    const forkId = chat.currentForkId!
    const version = (content: string) =>
      new NewVersion({
        speakerEntityId: null,
        writer: "human",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      })
    const a = yield* writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId,
      parentSlotId: null,
      branch: false,
      commitDraft: null,
      version: version("A")
    })
    const b = yield* writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId,
      parentSlotId: a.slotId,
      branch: false,
      commitDraft: null,
      version: version("B")
    })
    const sibling = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: forkId, atSlotId: b.slotId })).fork
      .id
    const inserted = yield* writer.InsertMessage({
      userId,
      chatId: chat.id,
      forkId,
      anchorSlotId: a.slotId,
      expectedRowVersion: 0,
      body: { _tag: "Write", speaker: null, content: "Mira leaves." }
    })
    yield* writer.AddStateEvent({
      userId,
      chatId: chat.id,
      forkId,
      slotId: inserted.slotId,
      versionId: null,
      scope: null,
      data: { key: "away.set", value: { entity: mira.entityId as EntityId, away: true } }
    })
    const swipe = yield* writer.AddVersion({
      userId,
      slotId: b.slotId,
      forkId,
      select: false,
      commitDraft: null,
      version: version("B again")
    })
    const other = yield* writer.AddVersion({
      userId,
      slotId: b.slotId,
      forkId: sibling,
      select: false,
      commitDraft: null,
      version: version("Other B")
    })
    const [rows] = yield* fixtureSql(
      config.dataDir,
      [{ sql: "SELECT id,presence_json FROM version_records WHERE id IN (?,?)", params: [swipe.id, other.id] }],
      { readOnly: true }
    )
    const record = (id: string) => rows!.find((r) => r.id === id)!.presence_json
    assert.deepStrictEqual(JSON.parse(record(swipe.id) as string), { away: [mira.entityId] })
    assert.isNull(record(other.id))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
})
