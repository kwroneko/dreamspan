import { Worker } from "node:worker_threads"
import { databaseFile } from "../src/db/connection.ts"
// A cold library's branch lists fill in while the first pass goes on (ARCHITECTURE.md §12): the
// rows of forks not read yet are `pending`, never wrong, and the pass reads each chat's current
// fork first, then the forks nearest it in its branch list. Synthetic fixtures, real workers.
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { ShellForksView } from "@dreamspan/shared/chatSetupApi.ts"
import { Effect, Exit, Stream } from "effect"
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
    return { writer, reader, userId, chat, main, forks, mira }
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

  it.live("a chat stays loading until all its branches are read, including after mutations", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, main, forks } = yield* setup("Harbor", 6)
      const first = yield* reader.ShellSummarizeStale({ userId })
      yield* writer.StoreForkSummaries({ userId, chats: first.chats })
      const partial = () => Effect.map(reader.ShellMaterializePartial({ userId }), snapshotState)
      const allView: ShellForksView = { ...chatView(chat.id), chat: null }
      let state = yield* partial()
      assert.deepStrictEqual(
        forksView(state.state, allView, state.labels).loading,
        { ready: 0, total: 1 },
        "the current fork is ready, but the chat still has unknown branch data"
      )
      const old = yield* reader.ShellSummarizeStale({ userId })
      yield* writer.SetForkName({ userId, forkId: forks[1]!, name: "New name" })
      const made = yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: null })
      yield* writer.DeleteFork({ userId, forkId: forks[2]! })
      // A result computed before the write is never shown as current after it.
      yield* writer.StoreForkSummaries({ userId, chats: old.chats })
      state = yield* partial()
      assert.isFalse(state.state.forks.some((f) => f.forkId === forks[2]))
      assert.isTrue(state.state.forks.some((f) => f.forkId === made.fork.id))
      assert.strictEqual(state.state.forks.find((f) => f.forkId === forks[1])!.name, "New name")
      const scratch = yield* reader.ShellLibrary({ userId, recompute: true })
      for (const row of state.state.forks.filter((f) => !f.pending)) {
        assert.deepStrictEqual(
          wire(row),
          scratch.forks.find((f) => f.forkId === row.forkId)
        )
      }
      yield* writer.DeleteChat({ userId, chatId: chat.id })
      state = yield* partial()
      assert.lengthOf(state.state.forks, 0)
    }).pipe(Effect.provide(database()))
  )

  it.live("partial operations and guessed ids never cross accounts", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, main } = yield* setup("Private harbor", 4)
      const foreign = (yield* writer.EnsureUser({ handle: "bea", displayName: "Bea" })).id
      const before = yield* reader.ShellMaterializePartial({ userId })
      assert.lengthOf((yield* reader.ShellMaterializePartial({ userId: foreign })).forks, 0)
      assert.deepStrictEqual(yield* reader.ShellSummarizeStale({ userId: foreign, chatId: chat.id }), {
        chats: [],
        remaining: 0
      })
      for (const read of [reader.GetSplitChatsFast, reader.GetSplitChatsPartial]) {
        const refused = yield* read({ userId: foreign, chatId: chat.id, forkId: main }).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(refused))
      }
      const guessed = forksView(
        snapshotState(yield* reader.ShellMaterializePartial({ userId: foreign })).state,
        chatView(chat.id),
        new Map()
      )
      assert.isTrue(guessed.sections.every((s) => s.rows.length === 0 && s.total === 0))
      const part = yield* reader.ShellSummarizeStale({ userId })
      yield* writer.StoreForkSummaries({ userId: foreign, chats: part.chats })
      assert.deepStrictEqual(yield* reader.ShellMaterializePartial({ userId }), before)
    }).pipe(Effect.provide(database()))
  )

  it.live("pending thread rows keep their classification and exact branch counts", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, main, mira } = yield* setup("Harbor", 4)
      const wren = yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Wren",
        subtitle: "",
        doc: cardDoc("Wren"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        forkId: main,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: wren.entityId } }
      })
      const path = yield* reader.GetPath({ userId, chatId: chat.id, forkId: main, leafSlotId: null, limit: 100 })
      const tip = path.entries.at(-1)!
      yield* writer.StartThreads({
        userId,
        chatId: chat.id,
        forkId: main,
        slotId: tip.slotId,
        expectedRowVersion: tip.rowVersion,
        threads: [
          { name: "Mira's thread", cast: [mira.entityId], writesAs: null },
          { name: "Wren's thread", cast: [wren.entityId], writesAs: null }
        ]
      })
      const partial = snapshotState(yield* reader.ShellMaterializePartial({ userId }))
      const full = yield* reader.ShellLibrary({ userId, recompute: true })
      for (const row of partial.state.forks) {
        const exact = full.forks.find((f) => f.forkId === row.forkId)!
        assert.deepStrictEqual(row.threads, exact.threads, "pending rows never classify a thread as a branch")
        assert.strictEqual(row.branches, exact.branches)
      }
    }).pipe(Effect.provide(database()))
  )

  it.live("pending endpoints skip deleted tips and include messages inserted after a tip", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, main, forks } = yield* setup("Harbor", 4)
      const path = yield* reader.GetPath({ userId, chatId: chat.id, forkId: main, leafSlotId: null, limit: 100 })
      yield* writer.DeleteMessage({ userId, forkId: main, slotId: path.entries.at(-1)!.slotId })
      const sameEnds = () =>
        Effect.gen(function* () {
          const partial = snapshotState(yield* reader.ShellMaterializePartial({ userId }))
          const full = yield* reader.ShellLibrary({ userId, recompute: true })
          for (const row of partial.state.forks)
            assert.strictEqual(
              row.endAt,
              full.forks.find((f) => f.forkId === row.forkId)!.endAt,
              "filling a row never changes its ordering date"
            )
        })
      yield* sameEnds()
      const visible = yield* reader.GetPath({ userId, chatId: chat.id, forkId: main, leafSlotId: null, limit: 100 })
      const tip = visible.entries.at(-1)!
      yield* writer.InsertMessage({
        userId,
        chatId: chat.id,
        forkId: main,
        anchorSlotId: tip.slotId,
        expectedRowVersion: tip.rowVersion,
        body: { _tag: "Write", speaker: null, content: "Inserted at the display end" }
      })
      yield* sameEnds()
      const other = yield* reader.GetPath({ userId, chatId: chat.id, forkId: forks[0]!, leafSlotId: null, limit: 100 })
      const otherTip = other.entries.at(-1)!
      yield* writer.InsertMessage({
        userId,
        chatId: chat.id,
        forkId: forks[0]!,
        anchorSlotId: otherTip.slotId,
        expectedRowVersion: otherTip.rowVersion,
        body: { _tag: "Write", speaker: null, content: "Inserted after a live structural tip" }
      })
      yield* sameEnds()
      const empty = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "First insertion",
        participants: [],
        greeting: null
      })
      yield* writer.InsertMessage({
        userId,
        chatId: empty.id,
        forkId: empty.currentForkId!,
        anchorSlotId: null,
        expectedRowVersion: 0,
        body: { _tag: "Write", speaker: null, content: "An insertion with no structural tip" }
      })
      yield* sameEnds()
    }).pipe(Effect.provide(database()))
  )

  it.live("pending endpoints inspect each chat's insertion anchors once", () => {
    const dataDir = tempDir("partial-anchors")
    return Effect.gen(function* () {
      const { writer, reader, userId, chat, main } = yield* setup("Harbor", 6)
      const path = yield* reader.GetPath({ userId, chatId: chat.id, forkId: main, leafSlotId: null, limit: 100 })
      const anchor = path.entries[0]!.slotId
      for (let n = 0; n < 2; n++) {
        const entry = yield* reader.GetSlot({ userId, slotId: anchor, forkId: main })
        yield* writer.InsertMessage({
          userId,
          chatId: chat.id,
          forkId: main,
          anchorSlotId: anchor,
          expectedRowVersion: entry.entry.rowVersion,
          body: { _tag: "Write", speaker: null, content: `Early insertion ${n}` }
        })
      }
      const counted = yield* Effect.promise(
        () =>
          new Promise<{ visits: number }>((resolve, reject) => {
            const worker = new Worker(new URL("./support/partialAnchorProbeWorker.ts", import.meta.url), {
              workerData: { file: databaseFile(dataDir), userId }
            })
            let result: { visits: number } | undefined
            worker.once("message", (value) => {
              result = value
            })
            worker.once("error", reject)
            worker.once("exit", (code) =>
              code === 0 && result ? resolve(result) : reject(new Error(`anchor probe exited ${code}`))
            )
          })
      )
      assert.equal(counted.visits, 2, "each anchor is read once, independent of the number of pending forks")
    }).pipe(
      Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })),
      Effect.scoped
    )
  })

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
