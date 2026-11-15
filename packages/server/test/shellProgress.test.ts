// A cold library's branch lists fill in while the first pass goes on (ARCHITECTURE.md §12): the
// rows of forks not read yet are `pending`, never wrong, and the pass reads each chat's current
// fork first, then the forks nearest it in its branch list. Synthetic fixtures, real workers.
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { ShellForksView } from "@rp/shared/chatSetupApi.ts"
import { Effect, Stream } from "effect"
import * as Database from "../src/db/Database.ts"
import { forksView, libraryView, snapshotState, wire } from "../src/db/shellViews.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const database = () =>
  Database.layer({ dataDir: tempDir("shellprogress"), readers: 2, allowNetworkFs: false, ...testWorkers })

/** A chat with a main branch of eight messages and `branches` more, each a message of its own. */
const setup = (title: string, branches: number) =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const { id: userId } = yield* writer.EnsureUser({ handle: "ana", displayName: "ana" })
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
      title,
      participants: [mira.entityId],
      greeting: null
    })
    const main = chat.currentForkId!
    const append = (parentSlotId: SlotId | null, content: string, speaker: EntityId | null, forkId: ForkId) =>
      writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId,
        parentSlotId,
        branch: false,
        version: new NewVersion({
          speakerEntityId: speaker,
          writer: speaker === null ? "human" : "model",
          content,
          status: "complete",
          macroMode: "verbatim",
          origin: speaker === null ? "user_written" : "generated"
        }),
        commitDraft: null
      })
    const slots: Array<SlotId> = []
    let parent: SlotId | null = null
    for (let n = 0; n < 8; n++) {
      const sent: { readonly slotId: SlotId } = yield* append(
        parent,
        `Main message ${n}.`,
        n % 2 === 0 ? null : mira.entityId,
        main
      )
      parent = sent.slotId
      slots.push(sent.slotId)
    }
    const forks: Array<ForkId> = []
    for (let n = 0; n < branches; n++) {
      const { fork } = yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: slots[n % 8]! })
      forks.push(fork.id)
      yield* append(slots[n % 8]!, `Only in branch ${n}.`, mira.entityId, fork.id)
    }
    // Chatting in main makes it the chat's current fork again.
    yield* append(parent, "Main goes on.", null, main)
    return { writer, reader, userId, chat, main, forks }
  })

const chatView = (chat: ChatId, search = ""): ShellForksView => ({
  entity: null,
  chat,
  search,
  sort: "recent",
  sections: [{ id: "all", limit: 1000 }]
})

describe("a cold library's branch lists", () => {
  it.live("list every fork at once, then fill in current first, and end as a full read", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, main, forks } = yield* setup("Harbor", 6)
      yield* writer.SetForkName({ userId, forkId: forks[2]!, name: "Lighthouse" })
      // Computed from scratch, storing nothing: the library stays cold.
      const { fresh: _, ...scratch } = yield* reader.ShellLibrary({ userId, recompute: true })
      const partial = snapshotState(yield* reader.ShellMaterializePartial({ userId }))
      const rows = partial.state.forks.filter((f) => f.chat.id === chat.id)
      assert.lengthOf(rows, forks.length + 1)
      for (const row of rows) {
        const full = scratch.forks.find((f) => f.forkId === row.forkId)!
        assert.isTrue(row.pending, "nothing is read yet")
        // Never a wrong preview or count: none until it is read.
        assert.strictEqual(row.preview, "")
        assert.strictEqual(row.messages, 0)
        // Its place in the list is its tip's, as the walk ends it.
        assert.strictEqual(row.endAt, full.endAt)
        assert.strictEqual(row.name, full.named ? full.name : row.name)
      }
      assert.deepStrictEqual(
        rows.map((f) => f.forkId),
        scratch.forks.filter((f) => f.chat.id === chat.id).map((f) => f.forkId),
        "the same rows, in the same order"
      )
      // The view says how many are ready, and a search finds pending forks by name only.
      const view = forksView(partial.state, chatView(chat.id), partial.labels)
      assert.deepStrictEqual(view.loading, { ready: 0, total: forks.length + 1 })
      const found = forksView(partial.state, chatView(chat.id, "lighthouse"), partial.labels)
      assert.deepStrictEqual(
        found.sections[0]!.rows.map((f) => f.forkId),
        [forks[2]!]
      )
      assert.lengthOf(forksView(partial.state, chatView(chat.id, "only in"), partial.labels).sections[0]!.rows, 0)

      // The first part reads the chat's current fork alone.
      const first = yield* reader.ShellSummarizeStale({ userId })
      const firstForks = first.chats.flatMap((c) =>
        (JSON.parse(c.forks) as Array<{ forkId: string }>).map((f) => f.forkId)
      )
      assert.deepStrictEqual(firstForks, [main])
      yield* writer.StoreForkSummaries({ userId, chats: first.chats })
      const after = snapshotState(yield* reader.ShellMaterializePartial({ userId }))
      const current = after.state.forks.find((f) => f.forkId === main)!
      assert.notProperty(current, "pending")
      assert.strictEqual(
        JSON.stringify(wire(current)),
        JSON.stringify(scratch.forks.find((f) => f.forkId === main)),
        "the current fork's row is the full read's"
      )
      assert.deepStrictEqual(forksView(after.state, chatView(chat.id), after.labels).loading, {
        ready: 1,
        total: forks.length + 1
      })

      // The rest, part by part, until none is left: then the partial read is the full one.
      for (let n = 0; n < 20; n++) {
        const part = yield* reader.ShellSummarizeStale({ userId })
        if (part.chats.length > 0) yield* writer.StoreForkSummaries({ userId, chats: part.chats })
        if (part.remaining === 0) break
      }
      const done = snapshotState(yield* reader.ShellMaterializePartial({ userId }))
      assert.isFalse(done.state.forks.some((f) => f.pending === true))
      assert.notProperty(forksView(done.state, chatView(chat.id), done.labels), "loading")
      const { fresh: __, ...filled } = libraryView(done.state)
      assert.strictEqual(JSON.stringify(filled), JSON.stringify(scratch), "the filled-in rows are the full read's")
    }).pipe(Effect.provide(database()))
  )

  it.live("an untitled chat's branch list opens once its current fork is read, its name never guessed", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, main } = yield* setup("", 4)
      const scratch = yield* reader.ShellLibrary({ userId, recompute: true })
      const named = scratch.forks.find((f) => f.forkId === main)!.chatName
      assert.strictEqual(named, "Mira")
      const partial = snapshotState(yield* reader.ShellMaterializePartial({ userId }))
      // Its name comes from its cast, which isn't read yet.
      assert.strictEqual(partial.state.forks.find((f) => f.forkId === main)!.chatName, "")
      assert.isNull(yield* reader.GetSplitChatsPartial({ userId, chatId: chat.id, forkId: null }))
      const first = yield* reader.ShellSummarizeStale({ userId, chatId: chat.id })
      yield* writer.StoreForkSummaries({ userId, chats: first.chats })
      const split = yield* reader.GetSplitChatsPartial({ userId, chatId: chat.id, forkId: null })
      assert.strictEqual(split?.group.title, named)
      assert.strictEqual(split?.forkIds.length, 5)
    }).pipe(Effect.provide(database()))
  )

  it.live("a watched branch list fills in as the pass goes, and ends with no progress", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Aria", name: "Aria" })
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Start.", speakerEntityId: null }
      })
      const chatId = started.chat.id
      const main = started.chat.currentForkId!
      const history = yield* api.ListForks({ chatId })
      const tip = history.find((f) => f.id === main)!.tipSlotId!
      for (let n = 0; n < 5; n++) yield* api.CreateFork({ chatId, fromForkId: main, atSlotId: tip })
      const seen = yield* api.WatchShellForks(chatView(chatId)).pipe(
        Stream.takeUntil((update) => update.loading === undefined),
        Stream.runCollect
      )
      const progress = [...seen].map((update) => update.loading)
      assert.isAbove(progress.length, 1, "the list was shown before the pass was done")
      assert.isDefined(progress[0], "the first answer was the stored rows, still loading")
      assert.isUndefined(progress[progress.length - 1])
      const readies = progress.flatMap((p) => (p === undefined ? [] : [p.ready]))
      assert.deepStrictEqual(
        readies,
        [...readies].sort((a, b) => a - b),
        "never fewer ready"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ shellPassPauseMs: 1500 }))))
  )
})
