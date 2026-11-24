import { assert, describe, it } from "@effect/vitest"
import { NewVersion, type ForkId, type SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { assembleFixture } from "./support/assemblySources.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { cardDoc } from "./support/docs.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture } from "./support/lcmFixtures.ts"

const config = testConfig()
const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = (yield* api.Whoami()).id
  const chat = yield* api.CreateChat({ title: "Synthetic insertion assembly" })
  const forkId = chat.currentForkId!
  const append = (parentSlotId: SlotId | null, content: string, fork = forkId, template = false) =>
    writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId: fork,
      parentSlotId,
      branch: false,
      commitDraft: null,
      version: new NewVersion({
        speakerEntityId: null,
        writer: "human",
        content,
        status: "complete",
        macroMode: template ? "template" : "verbatim",
        origin: "user_written"
      })
    })
  const insert = (anchorSlotId: SlotId | null, content: string) =>
    Effect.gen(function* () {
      const anchor = anchorSlotId === null ? null : yield* reader.GetSlot({ userId, slotId: anchorSlotId, forkId })
      return yield* writer.InsertMessage({
        userId,
        chatId: chat.id,
        forkId,
        anchorSlotId,
        expectedRowVersion: anchor?.entry.rowVersion ?? 0,
        body: { _tag: "Write", speaker: null, content }
      })
    })
  const assemble = (message: Effect.Success<ReturnType<typeof append>>, fork: ForkId = forkId) =>
    Effect.map(
      reader.AssembleContext({
        userId,
        chatId: chat.id,
        forkId: fork,
        slotId: message.slotId,
        versionId: message.version.id,
        now: Date.UTC(2026, 0, 1),
        timeZone: "UTC",
        frozen: null
      }),
      ({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot
    )
  return { api, writer, reader, userId, chat, forkId, append, insert, assemble }
})
const texts = (snapshot: ContextSnapshot) => snapshot.request.messages.map((m) => m.content).join("\n")

describe("insertion assembly review", () => {
  it.effect("keeps the version 38 fixture’s request bytes with the current end-of-request marker", () =>
    Effect.gen(function* () {
      // Captured on master 175acd7 using these same synthetic inputs, before unit 4.
      const before = JSON.parse(readFileSync(new URL("fixtures/preInsertionRequest.json", import.meta.url), "utf8"))
      const after = yield* assembleFixture({
        cards: [{ entity: "mira", doc: cardDoc("Mira") }],
        participants: ["mira"],
        messages: [
          { side: "assistant", content: "Welcome to the synthetic harbor." },
          { side: "user", content: "Where is the ledger?" }
        ],
        preset: importStPreset(JSON.stringify({ openai_max_context: 4096, openai_max_tokens: 300 })).document!
      })
      // Reasoning replay marks the existing end-of-request message (b4ba8bfa7).
      assert.strictEqual(JSON.stringify(after.request), JSON.stringify({ ...before, endMessage: true }))
    })
  )

  it.live("previews an insertion above the first message even with a null structural tip", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const x = yield* h.insert(null, "The opening drawing")
      const character = yield* h.writer.CreateEntity({
        userId: h.userId,
        kind: "card",
        label: "Opening cast",
        subtitle: "",
        doc: cardDoc("Opening cast"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId: h.chat.id,
        forkId: h.forkId,
        slotId: x.slotId,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: character.entityId } }
      })
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId: h.chat.id,
        forkId: h.forkId,
        slotId: x.slotId,
        versionId: null,
        scope: null,
        data: { key: "macro.binding", value: { name: "char", value: "Opening narrator" } }
      })
      const next = yield* h.api.GetNextContext({ chatId: h.chat.id, forkId: h.forkId, leafSlotId: null })
      assert.strictEqual(next.historyStart?.slotId, x.slotId)
      assert.strictEqual(next.historyStart?.depth, 0)
      const cast = yield* h.api.GetCast({ chatId: h.chat.id, forkId: h.forkId, slotId: null })
      assert.strictEqual(cast.macroNames.char, "Opening narrator")
      const summaries = yield* h.reader.ChatSummaries({ userId: h.userId, chatIds: [h.chat.id] })
      assert.include(
        summaries[0]!.cast.map((card) => card.entityId),
        character.entityId
      )
      const reply = yield* h.append(null, "Reply")
      const built = yield* h.assemble(reply)
      assert.include(texts(built), "The opening drawing")
      assert.strictEqual(built.sources!.target.depth, 1)
      assert.strictEqual(built.sources!.target.historyLeaf, x.slotId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  )

  it.live("regeneration sees the insertion before it and an event made later stays isolated from a fork at X", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const a = yield* h.append(null, "A")
      const b = yield* h.append(a.slotId, "B")
      const x = yield* h.insert(a.slotId, "X")
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId: h.chat.id,
        forkId: h.forkId,
        slotId: x.slotId,
        versionId: null,
        scope: null,
        data: { key: "macro.binding", value: { name: "char", value: "At X" } }
      })
      const atX = yield* h.writer.CreateFork({
        userId: h.userId,
        chatId: h.chat.id,
        fromForkId: h.forkId,
        atSlotId: x.slotId
      })
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId: h.chat.id,
        forkId: h.forkId,
        slotId: x.slotId,
        versionId: null,
        scope: null,
        data: { key: "macro.binding", value: { name: "char", value: "Later at X" } }
      })
      const regenerated = yield* h.assemble(b)
      assert.strictEqual(regenerated.sources!.target.depth, 2)
      assert.strictEqual(regenerated.sources!.target.historyLeaf, x.slotId)
      assert.include(texts(regenerated), "X")
      assert.notInclude(
        regenerated.sources!.history.flatMap((w) => w.entries).map((e) => e.slotId),
        b.slotId
      )
      const forkReply = yield* h.append(x.slotId, "Fork reply", atX.fork.id)
      const forked = yield* h.assemble(forkReply, atX.fork.id)
      assert.strictEqual(forked.sources!.target.depth, 2)
      const cast = yield* h.api.GetCast({ chatId: h.chat.id, forkId: atX.fork.id, slotId: forkReply.slotId })
      assert.strictEqual(cast.macroNames.char, "At X")
      assert.include(texts(forked), "X")
      assert.notInclude(
        forked.sources!.history.flatMap((w) => w.entries).map((e) => e.slotId),
        b.slotId
      )
      const replay = yield* h.reader.RebuildContext({ userId: h.userId, snapshot: JSON.stringify(regenerated) })
      assert.strictEqual(replay._tag, "Rebuilt")
      if (replay._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(replay.snapshot), regenerated)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  )

  it.live("an insertion after a summary cursor stays raw and macros use display positions", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const a = yield* h.append(null, "A")
      const b = yield* h.append(a.slotId, "B")
      yield* completeFixture(config.dataDir, h.writer, h.userId, h.chat.id, [
        { slotId: a.slotId, versionId: a.version.id, amendCount: 0 },
        { slotId: b.slotId, versionId: b.version.id, amendCount: 0 }
      ])
      const c = yield* h.append(b.slotId, "C")
      const x = yield* h.insert(b.slotId, "X")
      const template = yield* h.append(c.slotId, "NUMBER={{lastMessageId}}", h.forkId, true)
      const reply = yield* h.append(template.slotId, "Reply")
      const built = yield* h.assemble(reply)
      assert.strictEqual(built.sources!.lcm!.cursorDepth, 1)
      assert.include(texts(built), "X")
      assert.include(texts(built), "NUMBER=3")
      assert.strictEqual(built.sources!.history.flatMap((w) => w.entries).find((e) => e.slotId === x.slotId)!.depth, 2)
      const next = yield* h.api.GetNextContext({ chatId: h.chat.id, forkId: h.forkId, leafSlotId: reply.slotId })
      assert.strictEqual(next.summarizedThrough, 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  )
  it.live("counts inserted messages for lore delays and rebuilds the captured count", () =>
    Effect.gen(function* () {
      const h = yield* setup
      const lore = loreBook([loreEntry({ constant: true, delay: 3, content: "DELAY_AFTER_THREE" })]).document
      const card = yield* h.writer.CreateEntity({
        userId: h.userId,
        kind: "card",
        label: "Synthetic lore",
        subtitle: "",
        doc: { ...cardDoc("Synthetic lore"), character_book: lore },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId: h.chat.id,
        forkId: h.forkId,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: card.entityId } }
      })
      const a = yield* h.append(null, "A")
      const b = yield* h.append(a.slotId, "B")
      yield* h.insert(a.slotId, "X")
      const reply = yield* h.append(b.slotId, "Reply")
      const built = yield* h.assemble(reply)
      assert.include(texts(built), "DELAY_AFTER_THREE")
      assert.strictEqual(built.sources!.messageCount![0]!.count, 3)
      const replay = yield* h.reader.RebuildContext({ userId: h.userId, snapshot: JSON.stringify(built) })
      assert.strictEqual(replay._tag, "Rebuilt")
      if (replay._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(replay.snapshot), built)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  )
})
