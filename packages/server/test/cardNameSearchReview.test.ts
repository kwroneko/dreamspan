import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

it.live("search finds the display name and version shown by a pinned card revision", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id
    const doc = cardDoc("Pinned Display", { nickname: "PinnedModel", character_version: "pinned-version" })
    const made = yield* writer.CreateEntity({
      userId,
      kind: "card",
      label: doc.name,
      subtitle: "",
      doc,
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const started = yield* api.StartChat({
      cards: [made.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Synthetic", speakerEntityId: null }
    })
    yield* api.RenameChat({ chatId: started.chat.id, name: "Synthetic voyage" })
    yield* writer.AddStateEvent({
      userId,
      chatId: started.chat.id,
      slotId: null,
      versionId: null,
      scope: null,
      data: { key: "card.binding", value: { entity: made.entityId, revision: made.ref.headRevisionId } }
    })
    yield* writer.EditRef({
      userId,
      refId: made.ref.id,
      doc: { ...doc, name: "Head Display", nickname: "HeadModel", character_version: "head-version" },
      expectedRowVersion: made.ref.rowVersion,
      message: null,
      commitDraft: null
    })
    const [summary] = yield* api.ListChatSummaries({ chatIds: [started.chat.id] })
    assert.strictEqual(summary!.cast[0]!.name, "Pinned Display")
    assert.strictEqual(summary!.cast[0]!.subtitle, "pinned-version")
    const found = yield* api.ListChats({ limit: 50, before: null, search: "Pinned Display" })
    assert.include(
      found.map((chat) => chat.id),
      started.chat.id
    )
    for (const search of ["pinned-version", "PinnedModel"]) {
      assert.include(
        (yield* api.ListChats({ limit: 50, before: null, search })).map((chat) => chat.id),
        started.chat.id
      )
    }
    assert.notInclude(
      (yield* api.ListChats({ limit: 50, before: null, search: "Head Display" })).map((chat) => chat.id),
      started.chat.id
    )
    yield* writer.AddStateEvent({
      userId,
      chatId: started.chat.id,
      slotId: null,
      versionId: null,
      scope: null,
      data: { key: "card.binding", value: { entity: made.entityId } }
    })
    const local = yield* writer.CreateChatOverride({ userId, chatId: started.chat.id, refId: made.ref.id })
    yield* writer.EditRef({
      userId,
      refId: local.id,
      doc: { ...doc, name: "Local Display", character_version: "local-version" },
      expectedRowVersion: local.rowVersion,
      message: null,
      commitDraft: null
    })
    for (const search of ["Local Display", "local-version"]) {
      assert.include(
        (yield* api.ListChats({ limit: 50, before: null, search })).map((chat) => chat.id),
        started.chat.id
      )
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
