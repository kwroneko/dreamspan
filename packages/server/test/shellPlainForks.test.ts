// A parent's later choices cannot affect forks made before them. Treating those forks
// as overridden made a single old-message edit re-read every shared swipe-heavy prefix.
import { assert, it } from "@effect/vitest"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { Generator } from "../src/chat/Generator.ts"
import { shellPlainForksQuery } from "../src/db/shellQueries.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live("only choices within a fork's lineage bound prevent the shared tree read", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Synthetic",
      participants: [],
      greeting: null
    })
    const main = chat.currentForkId!
    const version = (content: string) =>
      new NewVersion({
        speakerEntityId: null,
        writer: "human",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      })
    const sent = yield* writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId: main,
      parentSlotId: null,
      branch: false,
      version: version("Original."),
      commitDraft: null
    })
    const slotId = sent.slotId
    const before = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: slotId })).fork.id
    const alternate = yield* writer.AddVersion({
      userId,
      slotId,
      forkId: main,
      version: version("Alternate."),
      select: false,
      commitDraft: null
    })
    yield* writer.SelectVersion({
      userId,
      slotId,
      forkId: main,
      versionId: alternate.id,
      expectedVersionId: sent.version.id
    })
    const after = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: slotId })).fork.id
    const nested = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: before, atSlotId: slotId })).fork.id
    const ids = [main, before, after, nested]
    const plain = () =>
      fixtureSql(config.dataDir, [{ sql: shellPlainForksQuery, params: [JSON.stringify(ids)] }], {
        readOnly: true
      }).pipe(Effect.map(([rows]) => rows!.map((row) => row.id)))
    assert.sameMembers(yield* plain(), [before, nested])
    // The new fork includes the parent's choice at its exact frozen bound; an older
    // fork and a nested fork of that older view keep the original selection.
    for (const forkId of [before, nested]) {
      const page = yield* api.ReadPath({
        chatId: chat.id,
        forkId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })
      assert.strictEqual(page.entries[0]!.version.id, sent.version.id)
    }
    const page = yield* api.ReadPath({
      chatId: chat.id,
      forkId: after,
      leafSlotId: null,
      range: { _tag: "Bottom" },
      limit: 10
    })
    assert.strictEqual(page.entries[0]!.version.id, alternate.id)
  }).pipe(Effect.provide(serverLayer(config, Generator.none)), Effect.scoped)
})
