// The shell's batch path resolver (db/forkPaths.ts) against the per-fork SQL walk: after a
// seeded run of every write that changes a fork's display path or its events (branches,
// swipes, selections, deletions, insertions, hides, scoped state events, fork deletion), each
// live fork's summary and outline read from one pass over its chat equals the one walked alone,
// and so do its path and event rows (`shellSlotsQuery`, `shellEventsQuery`).
import { assert, it } from "@effect/vitest"
import { type ForkId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { Worker } from "node:worker_threads"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { summaryValidSql } from "../src/db/summaryValidity.ts"
import { testWorkers } from "./support/bundles.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { tempDir } from "./support/tempDir.ts"

/** Deterministic, so a failure replays (mulberry32). */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

interface Probe {
  readonly forks: number
  /** The most live forks of one chat. */
  readonly chatForks: number
  readonly resolved: unknown
  readonly walked: unknown
  readonly outlines: unknown
  readonly walkedOutlines: unknown
  readonly paths: unknown
  readonly walkedPaths: unknown
  readonly events: unknown
  readonly walkedEvents: unknown
}

const probe = (file: string) =>
  Effect.promise(
    () =>
      new Promise<Probe>((resolve, reject) => {
        const worker = new Worker(new URL("./support/forkPathsProbeWorker.ts", import.meta.url), {
          workerData: { file }
        })
        let result: Probe | undefined
        worker.once("message", (value: Probe) => {
          result = value
        })
        worker.once("error", reject)
        worker.once("exit", (code) =>
          code === 0 && result ? resolve(result) : reject(new Error(`fork path probe exited ${code}`))
        )
      })
  )

it.live("one pass over a chat's tree resolves every fork as the per-fork walk does", () => {
  const dataDir = tempDir("fork-paths")
  return Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const { id: userId } = yield* writer.EnsureUser({ handle: "synthetic", displayName: "Synthetic" })
    const cards = yield* Effect.forEach(["Mira", "Tam", "Oren"], (name) =>
      writer.CreateEntity({
        userId,
        kind: "card",
        label: name,
        subtitle: "",
        doc: cardDoc(name),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    )
    const speakers = [null, ...cards.map((card) => card.entityId)]
    for (const [seed, title] of [
      [7, "Harbor"],
      [11, "Lighthouse"]
    ] as const) {
      const next = random(seed)
      const pick = <A>(list: ReadonlyArray<A>) => list[Math.floor(next() * list.length)]!
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title,
        participants: [cards[0]!.entityId],
        greeting: null
      })
      const version = (content: string) => {
        const speaker = pick(speakers)
        return new NewVersion({
          speakerEntityId: speaker,
          writer: speaker === null ? "human" : "model",
          content,
          status: "complete",
          macroMode: "verbatim",
          origin: speaker === null ? "user_written" : "generated"
        })
      }
      // What each fork was last seen to show: approximate on purpose, a refused write is skipped.
      const paths = new Map<ForkId, Array<SlotId>>([[chat.currentForkId!, []]])
      const versions = new Map<SlotId, Array<VersionId>>()
      const events: Array<{ readonly id: string; readonly slotId: SlotId; readonly forkId: ForkId }> = []
      const tried = <A>(effect: Effect.Effect<A, unknown>) => Effect.exit(effect)
      let overrides = 0
      /** A fork's own choice written as history edits write it (historyWrites.ts), in one transaction. */
      const override = (
        forkId: ForkId,
        kind: "replace" | "suppress_event",
        target: string,
        slotId: SlotId,
        value: string | null,
        flag: number | null
      ) => [
        { sql: "UPDATE chats SET state_seq = state_seq + 1 WHERE id = ?", params: [chat.id] },
        {
          sql: `INSERT INTO fork_overrides(id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag)
            VALUES(?, ?, ?, (SELECT state_seq FROM chats WHERE id = ?), ?, ?, ?, (SELECT depth FROM slots WHERE id = ?), ?, ?)`,
          params: [`${title}-o${overrides++}`, chat.id, forkId, chat.id, kind, target, slotId, slotId, value, flag]
        }
      ]
      for (let step = 0; step < 160; step++) {
        const forkId = pick([...paths.keys()])
        const path = paths.get(forkId)!
        const slotId = path.length > 0 ? pick(path) : null
        const roll = next()
        if (roll < 0.28 || slotId === null) {
          yield* tried(
            writer
              .AppendMessage({
                userId,
                chatId: chat.id,
                forkId,
                parentSlotId: path.at(-1) ?? null,
                branch: false,
                version: version(`Turn ${step}`),
                commitDraft: null
              })
              .pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    path.push(result.slotId)
                    versions.set(result.slotId, [result.version.id])
                  })
                )
              )
          )
        } else if (roll < 0.38) {
          yield* tried(
            writer
              .CreateFork({ userId, chatId: chat.id, fromForkId: forkId, atSlotId: slotId })
              .pipe(
                Effect.tap(({ fork }) => Effect.sync(() => paths.set(fork.id, path.slice(0, path.indexOf(slotId) + 1))))
              )
          )
        } else if (roll < 0.5) {
          yield* tried(
            writer
              .AddVersion({
                userId,
                slotId,
                forkId,
                version: version(`Swipe ${step}`),
                select: next() < 0.5,
                commitDraft: null
              })
              .pipe(Effect.tap((added) => Effect.sync(() => versions.get(slotId)?.push(added.id))))
          )
        } else if (roll < 0.58) {
          const list = versions.get(slotId) ?? []
          const target = list.length > 0 ? pick(list) : null
          if (target !== null) {
            const shown = yield* tried(reader.GetSlot({ userId, slotId, forkId }))
            if (shown._tag === "Success")
              yield* tried(
                writer.SelectVersion({
                  userId,
                  slotId,
                  versionId: target,
                  forkId,
                  expectedVersionId: shown.value.entry.version.id
                })
              )
          }
        } else if (roll < 0.63) {
          yield* tried(writer.DeleteMessage({ userId, slotId, forkId }))
        } else if (roll < 0.66) {
          const list = versions.get(slotId) ?? []
          if (list.length > 1) yield* tried(writer.DeleteVersion({ userId, versionId: pick(list), forkId }))
        } else if (roll < 0.72) {
          const shown = yield* tried(reader.GetSlot({ userId, slotId, forkId }))
          if (shown._tag === "Success")
            yield* tried(
              writer
                .InsertMessage({
                  userId,
                  chatId: chat.id,
                  forkId,
                  anchorSlotId: slotId,
                  expectedRowVersion: shown.value.entry.rowVersion,
                  body: { _tag: "Write", speaker: pick(speakers), content: `Inserted ${step}` }
                })
                .pipe(
                  Effect.tap((inserted) =>
                    Effect.sync(() => {
                      path.splice(path.indexOf(slotId) + 1, 0, inserted.slotId)
                      versions.set(inserted.slotId, [inserted.version.id])
                    })
                  )
                )
            )
        } else if (roll < 0.75) {
          yield* tried(writer.SetSlotHidden({ userId, slotId, forkId, hidden: next() < 0.7 }))
        } else if (roll < 0.82) {
          // An edit in this fork only: a copy of one of the message's versions stands in for it.
          const list = versions.get(slotId) ?? []
          if (list.length > 0) {
            const target = pick(list)
            const copy = `${title}-copy-${step}`
            const speaker = pick(speakers)
            yield* tried(
              fixtureSql(dataDir, [
                {
                  sql: `INSERT INTO version_records(id, slot_id, ordinal, status, writer, speaker_entity_id, content, macro_mode,
                      origin, source_version_id, fork_id, authoring_fork_id, created_at, updated_at)
                    VALUES(?, ?, (SELECT max(ordinal) + 1 FROM versions WHERE slot_id = ?), 'complete', ?, ?, ?, 'verbatim',
                      'edited', ?, ?, ?, ?, ?)`,
                  params: [
                    copy,
                    slotId,
                    slotId,
                    speaker === null ? "human" : "model",
                    speaker,
                    `Edited ${step}`,
                    target,
                    forkId,
                    forkId,
                    1_000 + step,
                    1_000 + step
                  ]
                },
                ...override(forkId, "replace", target, slotId, copy, null)
              ])
            )
          }
        } else if (roll < 0.88) {
          // A history edit's suppression of an event in this fork, sometimes undone: mostly one
          // the fork wrote itself (so it shows), else any of the chat's.
          const own = events.filter((e) => e.forkId === forkId)
          const event = own.length > 0 && next() < 0.7 ? pick(own) : events.length > 0 ? pick(events) : null
          if (event !== null)
            yield* tried(
              fixtureSql(
                dataDir,
                override(forkId, "suppress_event", event.id, event.slotId, null, next() < 0.8 ? 1 : 0)
              )
            )
        } else if (roll < 0.98) {
          // Joins and leaves, some only while one swipe is selected.
          const list = versions.get(slotId) ?? []
          const scoped = next() < 0.3 && list.length > 0 ? pick(list) : null
          const entity = pick(cards).entityId
          yield* tried(
            writer
              .AddStateEvent({
                userId,
                chatId: chat.id,
                forkId,
                slotId,
                versionId: scoped,
                scope: null,
                data:
                  next() < 0.7
                    ? { key: "participant.join", value: { entity } }
                    : { key: "participant.leave", value: { entity } }
              })
              .pipe(Effect.tap(({ id }) => Effect.sync(() => events.push({ id, slotId, forkId }))))
          )
        } else if (paths.size > 2) {
          yield* tried(
            writer.DeleteFork({ userId, forkId }).pipe(Effect.tap(() => Effect.sync(() => paths.delete(forkId))))
          )
        }
      }
    }
    // The run must reach every override kind the resolver reads, in a batch it resolves at once.
    const [kinds] = yield* fixtureSql(dataDir, [{ sql: "SELECT DISTINCT kind FROM fork_overrides ORDER BY kind" }], {
      readOnly: true
    })
    const seen = kinds!.map((row) => String(row.kind))
    for (const kind of ["delete_slot", "insert", "replace", "select", "suppress_event"])
      assert.include(seen, kind, `the run writes ${kind}`)
    const result = yield* probe(databaseFile(dataDir))
    assert.isAbove(result.forks, 10)
    assert.isAbove(result.chatForks, 8, "a chat has more forks than are walked by their paths alone")
    assert.deepStrictEqual(result.resolved, result.walked)
    assert.deepStrictEqual(result.outlines, result.walkedOutlines)
    assert.deepStrictEqual(result.paths, result.walkedPaths)
    assert.deepStrictEqual(result.events, result.walkedEvents)
  }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })), Effect.scoped)
})

it.live("a chat's branch read stores its stale summaries for the next read", () => {
  const dataDir = tempDir("fork-paths-store")
  return Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const { id: userId } = yield* writer.EnsureUser({ handle: "synthetic", displayName: "Synthetic" })
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
    const slots: Array<SlotId> = []
    for (let i = 0; i < 6; i++) {
      const appended: { readonly slotId: SlotId } = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId: main,
        parentSlotId: slots.at(-1) ?? null,
        branch: false,
        version: version(`Turn ${i}`),
        commitDraft: null
      })
      slots.push(appended.slotId)
    }
    const forks = [main]
    for (const at of [1, 3, 4])
      forks.push(
        (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: slots[at]! })).fork.id
      )
    const valid = Effect.map(
      fixtureSql(
        dataDir,
        [
          {
            sql: `SELECT s.fork_id FROM fork_summaries s JOIN chats c ON c.id = s.chat_id WHERE ${summaryValidSql(
              "s",
              "c",
              "coalesce((SELECT stamp FROM shell_user_stamps WHERE user_id = c.owner_user_id), 0)"
            )} ORDER BY s.fork_id`
          }
        ],
        { readOnly: true }
      ),
      ([rows]) => rows!.map((row) => String(row.fork_id))
    )
    assert.deepStrictEqual(yield* valid, [])
    yield* reader.ListForks({ userId, chatId: chat.id })
    assert.deepStrictEqual(yield* valid, [...forks].sort(), "every fork's summary is stored and valid")
    // A reply in one branch leaves the others valid; the next read stores that one again.
    yield* writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId: forks[1]!,
      parentSlotId: slots[1]!,
      branch: false,
      version: version("Branch reply"),
      commitDraft: null
    })
    const others = forks.filter((id) => id !== forks[1]).sort()
    assert.deepStrictEqual(yield* valid, others)
    // One stale fork is the branch read's own to walk (its path only), and the shell's to store.
    const listed = yield* reader.ListForks({ userId, chatId: chat.id })
    assert.deepStrictEqual(yield* valid, others)
    yield* reader.ShellMaterialize({ userId })
    assert.deepStrictEqual(yield* valid, [...forks].sort())
    assert.deepStrictEqual(yield* reader.ListForks({ userId, chatId: chat.id }), listed, "stored as walked")
  }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })), Effect.scoped)
})

// A part keeps the trees it read while writes go on (a reply streaming into the chat): the forks
// no write has reached since are walked from the kept tree, and must come out as walked now.
it.live("a kept tree walks the forks no write has reached since as they are now", () => {
  const dataDir = tempDir("fork-paths-kept")
  return Effect.gen(function* () {
    const writer = yield* Database.Writer
    const { id: userId } = yield* writer.EnsureUser({ handle: "synthetic", displayName: "Synthetic" })
    const cards = yield* Effect.forEach(["Mira", "Tam"], (name) =>
      writer.CreateEntity({
        userId,
        kind: "card",
        label: name,
        subtitle: "",
        doc: cardDoc(name),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    )
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Kept tree",
      participants: [cards[0]!.entityId],
      greeting: null
    })
    const version = (content: string, speaker: (typeof cards)[number]["entityId"] | null) =>
      new NewVersion({
        speakerEntityId: speaker,
        writer: speaker === null ? "human" : "model",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: speaker === null ? "user_written" : "generated"
      })
    const append = (
      forkId: ForkId,
      parentSlotId: SlotId | null,
      content: string,
      speaker: (typeof cards)[number]["entityId"] | null = cards[0]!.entityId
    ) =>
      Effect.map(
        writer.AppendMessage({
          userId,
          chatId: chat.id,
          forkId,
          parentSlotId,
          branch: false,
          version: version(content, speaker),
          commitDraft: null
        }),
        (appended): SlotId => appended.slotId
      )
    const main = chat.currentForkId!
    const slots: Array<SlotId> = []
    for (let i = 0; i < 8; i++)
      slots.push(yield* append(main, slots.at(-1) ?? null, `Turn ${i}`, i % 2 === 0 ? null : cards[0]!.entityId))
    const forks: Array<{ readonly id: ForkId; readonly tip: SlotId }> = [{ id: main, tip: slots.at(-1)! }]
    for (const at of [2, 4, 6]) {
      const { fork } = yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: slots[at]! })
      let tip = slots[at]!
      for (let i = 0; i < 2; i++) tip = yield* append(fork.id, tip, `Branch ${at}.${i}`)
      forks.push({ id: fork.id, tip })
    }
    yield* writer.AddVersion({
      userId,
      slotId: slots[3]!,
      forkId: main,
      version: version("An early swipe", cards[0]!.entityId),
      select: false,
      commitDraft: null
    })
    const reader = yield* Database.Reader
    yield* reader.ListForks({ userId, chatId: chat.id })
    const worker = new Worker(new URL("./support/keptTreeProbeWorker.ts", import.meta.url), {
      workerData: { file: databaseFile(dataDir), chatId: chat.id }
    })
    const next = <A>() =>
      Effect.promise(
        () =>
          new Promise<A>((resolve, reject) => {
            worker.once("message", resolve)
            worker.once("error", reject)
          })
      )
    yield* next<{ read: number }>()
    // Writes that reach some forks and not others: a new speaker's swipe in one branch's own
    // message, a reply there, a selected swipe in the main line past every branch, and a hidden
    // message in the main line.
    yield* writer.AddVersion({
      userId,
      slotId: forks[1]!.tip,
      forkId: forks[1]!.id,
      version: version("A new voice", cards[1]!.entityId),
      select: false,
      commitDraft: null
    })
    yield* append(forks[1]!.id, forks[1]!.tip, "A reply while the tree is kept")
    yield* writer.AddVersion({
      userId,
      slotId: slots[7]!,
      forkId: main,
      version: version("Chosen in the main line", cards[0]!.entityId),
      select: true,
      commitDraft: null
    })
    yield* writer.SetSlotHidden({ userId, slotId: slots[7]!, forkId: main, hidden: true })
    worker.postMessage("go")
    const result = yield* next<{ forks: number; kept: number; resolved: unknown; walked: unknown }>()
    yield* Effect.promise(() => worker.terminate())
    assert.deepStrictEqual(result.resolved, result.walked)
    assert.strictEqual(result.forks, 4)
    assert.isAbove(result.kept, 0, "some forks no write reached")
    assert.isBelow(result.kept, result.forks, "some forks a write reached")
  }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })), Effect.scoped)
})
