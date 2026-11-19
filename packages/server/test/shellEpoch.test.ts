import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { libraryView, snapshotState } from "../src/db/shellViews.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { docHash, searchText } from "../src/db/documents.ts"

it.live("every shell metadata write changes the owner epoch and the shared response agrees with a fresh read", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const userId = (yield* api.Whoami()).id
    const reader = yield* Reader
    const writer = yield* Writer
    const first = yield* api.CreateCard({ name: "Mira", label: "Mira" })
    const second = yield* api.CreateCard({ name: "Tam", label: "Tam" })
    const chat = yield* writer.CreateChat({
      userId,
      title: "",
      kind: "rp",
      status: "active",
      participants: [first.entityId, second.entityId],
      greeting: null
    })
    const main = chat.currentForkId!
    const posted = yield* writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId: main,
      parentSlotId: null,
      branch: false,
      commitDraft: null,
      version: new NewVersion({
        content: "At the quay",
        writer: "human",
        speakerEntityId: null,
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      })
    })
    const compare = (label: string) =>
      Effect.gen(function* () {
        const shared = libraryView(snapshotState(yield* reader.ShellMaterialize({ userId })).state)
        const fresh = yield* reader.ShellLibrary({ userId, recompute: true })
        const { fresh: _a, ...actual } = shared
        const { fresh: _b, ...expected } = fresh
        assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), label)
      })
    const change = <A, E, R>(label: string, write: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const before = yield* reader.ShellEpoch({ userId })
        const old = yield* reader.ShellMaterialize({ userId })
        const result = yield* write
        assert.notStrictEqual(yield* reader.ShellEpoch({ userId }), before, label)
        assert.notStrictEqual(yield* reader.ShellMaterialize({ userId }), old, `${label}: no stale shared snapshot`)
        yield* compare(label)
        return result
      })
    yield* change(
      "chat rename",
      writer.RenameChats({ userId, chats: [{ chatId: chat.id, from: null }], name: "Renamed story" })
    )
    const fork = yield* change(
      "fork",
      writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: posted.slotId })
    )
    yield* change("branch rename", writer.SetForkName({ userId, forkId: fork.fork.id, name: "East harbor" }))
    yield* change("branch pin", writer.SetForkPinned({ userId, forkId: fork.fork.id, pinned: true }))
    yield* change("chat pin", writer.SetChatPin({ userId, chatId: chat.id, leaf: null, pinned: true }))
    yield* change("favourite", writer.SetCardFavourite({ userId, entityId: first.entityId, favourite: true }))
    yield* change("split", writer.SetSplitChat({ userId, forkId: fork.fork.id, split: true }))
    yield* change("unsplit", writer.SetSplitChat({ userId, forkId: fork.fork.id, split: false }))
    const entry = yield* reader.GetSlot({ userId, slotId: posted.slotId, forkId: main })
    const threads = yield* change(
      "threads",
      writer.StartThreads({
        userId,
        chatId: chat.id,
        forkId: main,
        slotId: posted.slotId,
        expectedRowVersion: entry.entry.rowVersion,
        threads: [
          { name: "Quay", cast: [first.entityId], writesAs: null },
          { name: "Docks", cast: [second.entityId], writesAs: null }
        ]
      })
    )
    const set = (yield* reader.ThreadsOf({ userId, chatId: chat.id, forkId: main }))[0]!
    yield* change(
      "thread label",
      writer.RenameThread({
        userId,
        chatId: chat.id,
        splitId: threads.splitId,
        ordinal: 1,
        name: "Pier",
        rowVersion: set.threads[1]!.rowVersion
      })
    )
    const ref = yield* reader.GetRef({ userId, refId: first.id })
    yield* change(
      "card edit",
      writer.EditRef({
        userId,
        refId: first.id,
        doc: { ...cardDoc("Mira renamed") },
        expectedRowVersion: ref.ref.rowVersion,
        message: null,
        commitDraft: null
      })
    )
    yield* change("card archive", api.SetRefArchived({ refId: second.id, archived: true }))
    yield* change("workshop creation", api.CreateWorkshop({ title: "Synthetic workshop" }))
    const imported = cardDoc("Imported synthetic card")
    yield* change(
      "card import",
      writer.ImportFile({
        userId,
        intoRefId: null,
        kind: "card",
        label: "Imported synthetic card",
        docJson: JSON.stringify(imported),
        docHash: docHash(imported),
        searchText: searchText(imported),
        schemaVersion: 1,
        sourceName: "synthetic.json",
        sourceHash: "a".repeat(64),
        media: [],
        noteDocJson: null
      })
    )
    // Converting a preset creates another preset, outside the cards/forks shell.
    const preset = yield* api.CreatePreset({ label: "Synthetic source preset" })
    const beforeConversion = yield* reader.ShellEpoch({ userId })
    yield* api.ConvertPresetToWorkshop({
      refId: preset.id,
      label: "Synthetic workshop preset",
      choices: [],
      instructions: "Ask before changes."
    })
    assert.strictEqual(yield* reader.ShellEpoch({ userId }), beforeConversion, "preset conversion changes no shell row")
    yield* compare("preset conversion")
    yield* change("branch delete", writer.DeleteFork({ userId, forkId: fork.fork.id }))
    yield* change("chat delete", writer.DeleteChat({ userId, chatId: chat.id }))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)
