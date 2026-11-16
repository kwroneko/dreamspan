// Merging another chat into this one (spec/CHAT-MERGE.md §2, §3, §6, §8) through the real
// writer and readers: what comes in from an unrelated chat and from a branch of the same chat,
// the budget and the source's summaries, merging again, a merge in the middle of the history,
// the cast union, the stale-preview refusal, deleting the source, and deleting the join.
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { MergeRequest } from "@rp/shared/mergeApi.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { pathPieces } from "../src/db/displayPath.ts"
import { shownIn, slotDeletedIn } from "../src/db/forkState.ts"
import { sharedPrefix } from "../src/db/merges.ts"
import { docFor } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"
import { completeFixture } from "./support/lcmFixtures.ts"

const said = (speaker: EntityId | null, content: string, writer: "human" | "model" = "model") =>
  new NewVersion({
    speakerEntityId: speaker,
    writer,
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated"
  })

const setup = (dataDir: string) =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const card = (label: string) =>
      Effect.map(
        writer.CreateEntity({
          userId,
          kind: "card",
          label,
          subtitle: "",
          doc: docFor("card", label),
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
    const append = (
      at: { chatId: ChatId; forkId: ForkId },
      parent: SlotId | null,
      speaker: EntityId,
      content: string
    ) =>
      Effect.map(
        writer.AppendMessage({
          userId,
          chatId: at.chatId,
          forkId: at.forkId,
          parentSlotId: parent,
          branch: false,
          version: said(speaker, content),
          commitDraft: null
        }),
        (sent) => sent.slotId
      )
    const many = (at: { chatId: ChatId; forkId: ForkId }, speaker: EntityId, texts: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const [row] = yield* readOnly(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql<{ tip: SlotId | null }>`SELECT tip_slot_id AS tip FROM forks WHERE id = ${at.forkId}`
          )
        )
        let parent = row!.tip
        const ids: Array<SlotId> = []
        for (const text of texts) ids.push((parent = yield* append(at, parent, speaker, text)))
        return ids
      })
    const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })))
    /** The texts a fork shows, in display order, without what it deleted. */
    const shows = (forkId: ForkId, chatId: ChatId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{ tip: string | null }>`SELECT tip_slot_id AS tip FROM forks WHERE id = ${forkId}`
        const out: Array<{ id: string; content: string; origin: string }> = []
        for (const piece of yield* pathPieces(sql, chatId, forkId, row!.tip)) {
          const rows =
            piece.kind !== "run"
              ? yield* sql<{ id: string; content: string; origin: string; deleted: number }>`
                  SELECT s.id, v.content, v.origin, ${slotDeletedIn(sql, forkId, "s")} AS deleted FROM slots s
                  JOIN version_records v ON v.id = ${shownIn(sql, forkId, "s")} WHERE s.id = ${piece.slotId}`
              : yield* sql<{ id: string; content: string; origin: string; deleted: number }>`
                  SELECT s.id, v.content, v.origin, ${slotDeletedIn(sql, forkId, "s")} AS deleted FROM slots s
                  JOIN version_records v ON v.id = ${shownIn(sql, forkId, "s")}
                  WHERE s.chain_id = ${piece.chainId} AND s.depth BETWEEN ${piece.lo} AND ${piece.hi} ORDER BY s.depth`
          out.push(...rows.filter((r) => !r.deleted))
        }
        return out
      }).pipe(readOnly)
    const joined = (chatId: ChatId, slotId: string) =>
      readOnly(
        Effect.map(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql<{ entity: string }>`
            SELECT value_json ->> 'entity' AS entity FROM state_events
            WHERE chat_id = ${chatId} AND slot_id = ${slotId} AND key = 'participant.join'`
          ),
          (rows) => rows.map((r) => r.entity)
        )
      )
    const preview = (request: Omit<MergeRequest, "includeLeftOut"> & { includeLeftOut?: boolean }) =>
      reader.PreviewChatMerge({ userId, includeLeftOut: false, ...request })
    const merge = (request: Omit<MergeRequest, "includeLeftOut"> & { includeLeftOut?: boolean }) =>
      Effect.gen(function* () {
        const seen = yield* preview(request)
        return yield* writer.MergeChat({
          userId,
          includeLeftOut: false,
          ...request,
          title: seen.sourceTitle,
          framing: null,
          digest: seen.digest
        })
      })
    return { writer, reader, userId, mira, kai, chat, append, many, shows, joined, preview, merge, readOnly }
  })

const run = <A, E>(body: (dataDir: string) => Effect.Effect<A, E, Database.Writer | Database.Reader>) => {
  const dataDir = tempDir("chat-merge")
  return body(dataDir).pipe(
    Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers }))
  )
}

const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    assert.isTrue(Exit.isFailure(exit), "refused")
    return Exit.isFailure(exit) ? String(exit.cause) : ""
  })

describe("sharedPrefix", () => {
  it("counts the positions two display paths share", () => {
    const run = (chainId: string, lo: number, hi: number, start: number) => ({
      kind: "run" as const,
      chainId,
      lo,
      hi,
      start
    })
    assert.strictEqual(sharedPrefix([run("a", 0, 9, 0)], [run("a", 0, 4, 0), run("b", 5, 8, 5)]), 5)
    assert.strictEqual(sharedPrefix([run("a", 0, 9, 0)], [run("a", 0, 9, 0)]), 10)
    assert.strictEqual(sharedPrefix([run("a", 0, 3, 0)], [run("c", 0, 3, 0)]), 0)
    const inserted = { kind: "inserted" as const, slotId: "x", chainId: "x", depth: 3, start: 3 }
    assert.strictEqual(
      sharedPrefix([run("a", 0, 2, 0), inserted, run("a", 3, 5, 4)], [run("a", 0, 2, 0), run("a", 3, 5, 3)]),
      3
    )
    assert.strictEqual(
      sharedPrefix([run("a", 0, 2, 0), inserted, run("a", 3, 5, 4)], [run("a", 0, 2, 0), inserted, run("a", 3, 4, 4)]),
      6
    )
  })
})

describe("merging another chat", () => {
  it.live("brings an unrelated chat's messages in as one join, with its cast, and only what's new later", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const away = yield* t.chat("Docks", [t.kai])
        yield* t.many(home, t.mira, ["h1", "h2", "h3"])
        yield* t.many(away, t.kai, ["d1", "d2"])

        const seen = yield* t.preview({ ...home, at: null, source: away })
        assert.isFalse(seen.sameChat)
        assert.strictEqual(seen.shared, 0)
        assert.strictEqual(seen.messages, 2)
        assert.strictEqual(seen.verbatim, 2)
        assert.strictEqual(seen.at.number, 3)
        assert.deepStrictEqual(seen.start, { slotId: seen.at.slotId, number: 3 })
        assert.deepStrictEqual(
          seen.cast.map((c) => [c.name, c.added]),
          [
            ["Mira", false],
            ["Kai", true]
          ]
        )
        assert.strictEqual(seen.section, "Kai: d1\n\nKai: d2")
        assert.strictEqual(seen.framing, "Meanwhile, in parallel with what follows: Docks, with Kai.")

        const made = yield* t.merge({ ...home, at: null, source: away })
        assert.strictEqual(made.position, 3)
        const after = yield* t.shows(home.forkId, home.chatId)
        assert.deepStrictEqual(
          after.map((m) => m.origin),
          ["generated", "generated", "generated", "merge"]
        )
        assert.deepStrictEqual(yield* t.joined(home.chatId, made.slotId), [t.kai])
        const info = yield* t.reader.GetMerge({ userId: t.userId, chatId: home.chatId, slotId: made.slotId })
        assert.strictEqual(info.title, "Docks")
        assert.isTrue(info.sourceLive)
        assert.deepStrictEqual(info.cast, ["Kai"])
        const copied = yield* t.reader.MergeMessages({
          userId: t.userId,
          chatId: home.chatId,
          mergeId: info.id,
          offset: 0,
          limit: 50
        })
        assert.deepStrictEqual(
          copied.map((m) => [m.speakerName, m.content, m.included]),
          [
            ["Kai", "d1", "verbatim"],
            ["Kai", "d2", "verbatim"]
          ]
        )

        // Nothing new: refused. New messages in the source: only those, after the last join.
        assert.include(yield* refusal(t.preview({ ...home, at: null, source: away })), "Nothing new")
        yield* t.many(home, t.mira, ["h4"])
        yield* t.many(away, t.kai, ["d3"])
        const again = yield* t.preview({ ...home, at: null, source: away })
        assert.isTrue(again.continues)
        assert.strictEqual(again.messages, 1)
        assert.strictEqual(again.section, "Kai: d3")
        // The span starts after the earlier join.
        assert.strictEqual(again.start?.number, 5)
        assert.isFalse(again.cast.some((c) => c.added))

        // The source can go: the destination keeps its join and its copy.
        yield* t.writer.DeleteChat({ userId: t.userId, chatId: away.chatId })
        const gone = yield* t.reader.GetMerge({ userId: t.userId, chatId: home.chatId, slotId: made.slotId })
        assert.isFalse(gone.sourceLive)
        assert.isNull(gone.sourceChatId)
        assert.strictEqual((yield* t.shows(home.forkId, home.chatId)).length, 5)
      })
    )
  )

  it.live("merges only the part after the common prefix of two branches of one chat", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const [, , p3] = yield* t.many(home, t.mira, ["p1", "p2", "p3"])
        const made = yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: home.chatId,
          fromForkId: home.forkId,
          atSlotId: p3!
        })
        const side = { chatId: home.chatId, forkId: made.fork.id as ForkId }
        yield* t.many(side, t.kai, ["s1", "s2"])
        yield* t.many(home, t.mira, ["m1"])
        const seen = yield* t.preview({ ...home, at: null, source: side })
        assert.isTrue(seen.sameChat)
        assert.strictEqual(seen.shared, 3)
        assert.strictEqual(seen.from, 4)
        assert.strictEqual(seen.messages, 2)
        assert.strictEqual(seen.start?.number, 4)
        assert.strictEqual(seen.section, "Kai: s1\n\nKai: s2")
        // Merging a branch into itself is refused; so is one that adds nothing.
        assert.include(yield* refusal(t.preview({ ...home, at: null, source: home })), "itself")
        yield* t.merge({ ...home, at: null, source: side })
        assert.deepStrictEqual(
          (yield* t.shows(home.forkId, home.chatId)).map((m) => m.content.split("\n")[0]),
          ["p1", "p2", "p3", "m1", "Kai: s1"]
        )
        // The source branch is untouched.
        assert.deepStrictEqual(
          (yield* t.shows(side.forkId, side.chatId)).map((m) => m.content),
          ["p1", "p2", "p3", "s1", "s2"]
        )
      })
    )
  )

  it.live("merges below an earlier message: inserted there, and a fork made before it never shows it", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const away = yield* t.chat("Docks", [t.kai])
        const [h1, h2] = yield* t.many(home, t.mira, ["h1", "h2", "h3"])
        yield* t.many(away, t.kai, ["d1"])
        const before = yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: home.chatId,
          fromForkId: home.forkId,
          atSlotId: h1!
        })
        const seen = yield* t.preview({ ...home, at: h2!, source: away })
        assert.strictEqual(seen.at.number, 2)
        const made = yield* t.merge({ ...home, at: h2!, source: away })
        assert.strictEqual(made.position, 2)
        assert.deepStrictEqual(
          (yield* t.shows(home.forkId, home.chatId)).map((m) => m.content),
          ["h1", "h2", "Kai: d1", "h3"]
        )
        assert.deepStrictEqual(
          (yield* t.shows(before.fork.id as ForkId, home.chatId)).map((m) => m.content),
          ["h1"]
        )
        // Deleting the join takes the merge out of the fork; its cast joins stop applying with it.
        yield* t.writer.DeleteMessage({ userId: t.userId, slotId: made.slotId, forkId: home.forkId })
        assert.deepStrictEqual(
          (yield* t.shows(home.forkId, home.chatId)).map((m) => m.content),
          ["h1", "h2", "h3"]
        )
        // With the join deleted, the same messages can be merged again.
        const again = yield* t.preview({ ...home, at: null, source: away })
        assert.isFalse(again.continues)
        assert.strictEqual(again.messages, 1)
      })
    )
  )

  it.live("fits the source to the destination's span, from its summaries or leaving the rest out", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const away = yield* t.chat("Docks", [t.kai])
        yield* t.many(home, t.mira, ["short"])
        // About 40 tokens a message (4 characters a token): the 4,000-token floor holds about 95.
        yield* t.many(
          away,
          t.kai,
          Array.from({ length: 150 }, (_, i) => `${i} ${"x".repeat(150)}`)
        )
        const seen = yield* t.preview({ ...home, at: null, source: away })
        assert.strictEqual(seen.budget, 4_000)
        assert.strictEqual(seen.messages, 150)
        assert.isBelow(seen.verbatim, 150)
        assert.isAbove(seen.verbatim, 80)
        assert.strictEqual(seen.leftOut, 150 - seen.verbatim)
        assert.isAtMost(seen.tokens, 4_100)
        assert.match(seen.section, /^\[\d+ earlier messages of “Docks” not included\.\]/)
        const all = yield* t.preview({ ...home, at: null, source: away, includeLeftOut: true })
        assert.strictEqual(all.section.split("\n\n").length, 150)
      })
    )
  )

  it.live("keeps the merge cast positional and restores deleted joins independently of later forks", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const away = yield* t.chat("Docks", [t.kai])
        const [h1, h2, h3] = yield* t.many(home, t.mira, ["h1", "h2", "h3"])
        yield* t.many(away, t.kai, ["d1"])
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          ...home,
          slotId: h3!,
          versionId: null,
          scope: null,
          data: { key: "participant.join", value: { entity: t.kai } }
        })
        const made = yield* t.merge({ ...home, at: h2!, source: away })
        const cast = (forkId: ForkId, slotId: SlotId) =>
          Effect.map(
            t.reader.StateEventsAt({
              userId: t.userId,
              chatId: home.chatId,
              forkId,
              slotId
            }),
            (events) => foldState(events).participants
          )
        assert.deepStrictEqual(yield* cast(home.forkId, h1!), [t.mira])
        assert.deepStrictEqual(yield* cast(home.forkId, made.slotId), [t.mira, t.kai])
        const later = yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: home.chatId,
          fromForkId: home.forkId,
          atSlotId: made.slotId
        })
        const bin = yield* t.writer.DeleteMessage({ userId: t.userId, slotId: made.slotId, forkId: home.forkId })
        assert.deepStrictEqual(yield* cast(home.forkId, h2!), [t.mira])
        assert.deepStrictEqual(yield* cast(later.fork.id, made.slotId), [t.mira, t.kai])
        yield* t.writer.RestoreBinItem({ userId: t.userId, itemId: bin.id })
        assert.deepStrictEqual(yield* cast(home.forkId, made.slotId), [t.mira, t.kai])
        assert.deepStrictEqual(
          (yield* t.shows(home.forkId, home.chatId)).map((m) => m.content),
          ["h1", "h2", "Kai: d1", "h3"]
        )
        yield* t.many(away, t.kai, ["d2"])
        assert.deepStrictEqual(
          (yield* t.shows(home.forkId, home.chatId)).map((m) => m.content),
          ["h1", "h2", "Kai: d1", "h3"]
        )
      })
    )
  )

  it.live("does not re-import a source's own join after its transcript was edited", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const away = yield* t.chat("Docks", [t.kai])
        const third = yield* t.chat("Market", [t.mira])
        yield* t.many(home, t.mira, ["h1"])
        yield* t.many(away, t.kai, ["d1"])
        yield* t.many(third, t.mira, ["market"])
        const nested = yield* t.merge({ ...away, at: null, source: third })
        const original = yield* t.reader.GetSlot({ userId: t.userId, slotId: nested.slotId, forkId: away.forkId })
        const edited = yield* t.writer.ApplyHistoryEdits({
          userId: t.userId,
          title: "Edit the merged transcript",
          applications: [
            {
              ...away,
              edits: [
                {
                  kind: "version_replace",
                  targetId: original.entry.version.id,
                  beforeId: original.entry.version.id,
                  before: original.entry.version.content,
                  after: "Edited market transcript"
                }
              ]
            }
          ]
        })
        const seen = yield* t.preview({ ...home, at: null, source: away })
        assert.strictEqual(seen.messages, 1)
        assert.include(seen.section, "[1 chat merged into “Docks” not included.]")
        assert.notInclude(seen.section, "Edited market transcript")
        const undo = yield* t.writer.UndoHistoryEdit({
          userId: t.userId,
          ...away,
          changesetId: edited.changesetIds[0]!
        })
        assert.strictEqual(undo.undone, 1)
        assert.strictEqual((yield* t.shows(away.forkId, away.chatId)).at(-1)!.content, "Mira: market")
        assert.strictEqual((yield* t.preview({ ...home, at: null, source: away })).messages, 1)
      })
    )
  )

  it.live("treats a different swipe in the shared slots as divergence", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const [p1, p2] = yield* t.many(home, t.mira, ["common", "main telling"])
        const fork = yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: home.chatId,
          fromForkId: home.forkId,
          atSlotId: p2!
        })
        const side = { chatId: home.chatId, forkId: fork.fork.id as ForkId }
        yield* t.writer.AddVersion({
          userId: t.userId,
          slotId: p2!,
          forkId: side.forkId,
          version: said(t.mira, "side telling"),
          select: true,
          commitDraft: null
        })
        yield* t.many(side, t.mira, ["side continuation"])
        yield* t.many(home, t.mira, ["main continuation"])
        const seen = yield* t.preview({ ...home, at: null, source: side })
        assert.strictEqual(seen.shared, 1)
        assert.strictEqual(seen.from, 2)
        assert.strictEqual(seen.section, "Mira: side telling\n\nMira: side continuation")
        assert.strictEqual(seen.start?.slotId, p2)
        assert.strictEqual((yield* t.shows(home.forkId, home.chatId))[0]!.id, p1)
      })
    )
  )

  it.live("refuses same-length source edits after preview", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const away = yield* t.chat("Docks", [t.kai])
        yield* t.many(home, t.mira, ["h1"])
        const [slotId] = yield* t.many(away, t.kai, ["d1"])
        const request = { ...home, at: null, source: away, includeLeftOut: false }
        const seen = yield* t.preview(request)
        yield* t.writer.AddVersion({
          userId: t.userId,
          slotId: slotId!,
          forkId: away.forkId,
          version: said(t.kai, "d2"),
          select: true,
          commitDraft: null
        })
        assert.include(
          yield* refusal(
            t.writer.MergeChat({
              userId: t.userId,
              ...request,
              title: "Docks",
              framing: null,
              digest: seen.digest
            })
          ),
          "MergeChanged"
        )
      })
    )
  )

  it.live("keeps summary ranges aligned with the copied source messages", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const away = yield* t.chat("Docks", [t.kai])
        yield* t.many(home, t.mira, ["h1"])
        yield* t.many(
          away,
          t.kai,
          ["d1", "d2", "d3", "d4"].map((x) => x + "x".repeat(8000))
        )
        const path = yield* t.reader.GetPath({ userId: t.userId, ...away, leafSlotId: null, limit: 10 })
        const inputs = path.entries
          .slice(0, 2)
          .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 }))
        yield* completeFixture(dataDir, t.writer, t.userId, away.chatId, inputs, [], "First two source messages.")
        const seen = yield* t.preview({ ...home, at: null, source: away })
        assert.strictEqual(seen.summaries, 1)
        assert.include(seen.section, '<summary from="1" to="2">')
        const made = yield* t.merge({ ...home, at: null, source: away })
        const info = yield* t.reader.GetMerge({ userId: t.userId, chatId: home.chatId, slotId: made.slotId })
        const copied = yield* t.reader.MergeMessages({
          userId: t.userId,
          chatId: home.chatId,
          mergeId: info.id,
          offset: 0,
          limit: 50
        })
        assert.deepStrictEqual(
          copied.filter((m) => m.kind === "message").map((m) => m.included),
          ["summarized", "summarized", "left_out", "verbatim"]
        )
      })
    )
  )

  for (const summarizedMessages of [2, 3])
    it.live(`uses the requested source fork summary over ${summarizedMessages} messages`, () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const home = yield* t.chat("Harbor", [t.mira])
          const away = yield* t.chat("Docks", [t.kai])
          yield* t.many(home, t.mira, ["h1"])
          const ids = yield* t.many(
            away,
            t.kai,
            ["d1", "d2", "d3", "d4"].map((x) => x + "x".repeat(8000))
          )
          const path = yield* t.reader.GetPath({ userId: t.userId, ...away, leafSlotId: null, limit: 10 })
          const inputs = path.entries
            .slice(0, summarizedMessages)
            .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 }))
          const summary = yield* completeFixture(
            dataDir,
            t.writer,
            t.userId,
            away.chatId,
            inputs,
            [],
            "Original source summary."
          )
          const fork = yield* t.writer.CreateFork({
            userId: t.userId,
            chatId: away.chatId,
            fromForkId: away.forkId,
            atSlotId: ids.at(-1)!
          })
          yield* t.writer.EditSummary({
            userId: t.userId,
            summaryId: summary.id,
            forkId: fork.fork.id,
            content: "Other fork's summary.",
            expectedRowVersion: summary.rowVersion,
            commitDraft: null
          })
          const seen = yield* t.preview({ ...home, at: null, source: away })
          assert.strictEqual(seen.summaries, 1)
          assert.strictEqual(seen.leftOut, 3 - summarizedMessages)
          assert.include(seen.section, "Original source summary.")
          assert.notInclude(seen.section, "Other fork's summary.")
        })
      )
    )

  it.live("reports a summary rewrite only when the merge goes inside its range", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const away = yield* t.chat("Docks", [t.kai])
        const [h1, h2] = yield* t.many(home, t.mira, ["h1", "h2", "h3"])
        yield* t.many(away, t.kai, ["d1"])
        const path = yield* t.reader.GetPath({ userId: t.userId, ...home, leafSlotId: null, limit: 10 })
        const inputs = path.entries
          .slice(0, 2)
          .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 }))
        yield* completeFixture(dataDir, t.writer, t.userId, home.chatId, inputs, [], "First two home messages.")
        const inside = yield* t.preview({ ...home, at: h1!, source: away })
        assert.deepStrictEqual(inside.rewrites && [inside.rewrites.from, inside.rewrites.to], [1, 2])
        assert.isNull((yield* t.preview({ ...home, at: h2!, source: away })).rewrites)
      })
    )
  )

  it.live("refuses a write whose preview went stale, with the new preview", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const home = yield* t.chat("Harbor", [t.mira])
        const away = yield* t.chat("Docks", [t.kai])
        yield* t.many(home, t.mira, ["h1"])
        yield* t.many(away, t.kai, ["d1"])
        const seen = yield* t.preview({ ...home, at: null, source: away })
        yield* t.many(away, t.kai, ["d2"])
        const stale = yield* refusal(
          t.writer.MergeChat({
            userId: t.userId,
            ...home,
            at: null,
            source: away,
            includeLeftOut: false,
            title: "Docks",
            framing: null,
            digest: seen.digest
          })
        )
        assert.include(stale, "MergeChanged")
      })
    )
  )
})
