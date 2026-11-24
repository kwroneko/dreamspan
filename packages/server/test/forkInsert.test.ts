// Inserting messages and forks (spec/MESSAGE-INSERT.md §2.4, §7, unit 2): an isolation matrix
// through the real writer. An insertion shows in the fork it was made in and in forks made
// from it afterwards, never in one made before or beside it; a fork made at a message shows
// exactly what its parent showed up to there; the branch switcher never lists an inserted
// message; refusals; Duplicate.
import { SqliteClient } from "@effect/sql-sqlite-node"
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
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { pathPieces } from "../src/db/displayPath.ts"
import { shownIn, slotDeletedIn } from "../src/db/forkState.ts"
import type { InsertBody } from "@dreamspan/shared/messagesApi.ts"
import { docFor } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const said = (
  speaker: EntityId | null,
  content: string,
  writer: "human" | "model" = "model",
  status: "complete" | "generating" | "failed" = "complete"
) =>
  new NewVersion({
    speakerEntityId: speaker,
    writer,
    content,
    status,
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated",
    ...(status === "failed" ? { error: { class: "provider", message: "boom" } } : {})
  })

const setup = (dataDir: string) =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const card = (userId: UserId, label: string) =>
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
        (made) => made.entityId
      )
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const otherId = (yield* writer.EnsureUser({ handle: "bo", displayName: "Bo" })).id as UserId
    const mira = yield* card(userId, "Mira")
    const theirs = yield* card(otherId, "Theirs")
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Harbor",
      participants: [mira],
      greeting: null
    })
    const chatId = chat.id as ChatId
    const main = chat.currentForkId! as ForkId

    const append = (forkId: ForkId, parent: SlotId | null, content: string, writerKind: "human" | "model" = "model") =>
      Effect.map(
        writer.AppendMessage({
          userId,
          chatId,
          forkId,
          parentSlotId: parent,
          branch: false,
          version: said(mira, content, writerKind),
          commitDraft: null
        }),
        (sent) => sent.slotId
      )
    const entry = (slotId: SlotId, forkId: ForkId) =>
      Effect.map(reader.GetSlot({ userId, slotId, forkId }), (found) => found.entry)
    const insertBody = (forkId: ForkId, anchor: SlotId | null, body: InsertBody, rowVersion?: number) =>
      Effect.gen(function* () {
        const expected = rowVersion ?? (anchor === null ? 0 : (yield* entry(anchor, forkId)).rowVersion)
        return yield* writer.InsertMessage({
          userId,
          chatId,
          forkId,
          anchorSlotId: anchor,
          expectedRowVersion: expected,
          body
        })
      })
    const insert = (forkId: ForkId, anchor: SlotId | null, content: string, speaker: EntityId | null = mira) =>
      Effect.map(insertBody(forkId, anchor, { _tag: "Write", speaker, content }), (made) => made.slotId)
    const fork = (from: ForkId, at: SlotId | null) =>
      Effect.map(writer.CreateFork({ userId, chatId, fromForkId: from, atSlotId: at }), (made) => made.fork.id)

    /** Every slot on `forkId`'s display path, in order, with its text there and whether it's deleted there. */
    const display = (forkId: ForkId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{ tip: string | null }>`SELECT tip_slot_id AS tip FROM forks WHERE id = ${forkId}`
        const slots: Array<{ id: SlotId; content: string; deleted: number }> = []
        for (const piece of yield* pathPieces(sql, chatId, forkId, row!.tip)) {
          const found =
            piece.kind !== "run"
              ? yield* sql<{ id: SlotId; content: string; deleted: number }>`
                  SELECT s.id, (SELECT content FROM version_records WHERE id = ${shownIn(sql, forkId, "s")}) AS content,
                    ${slotDeletedIn(sql, forkId, "s")} AS deleted FROM slots s WHERE s.id = ${piece.slotId}`
              : yield* sql<{ id: SlotId; content: string; deleted: number }>`
                  SELECT s.id, (SELECT content FROM version_records WHERE id = ${shownIn(sql, forkId, "s")}) AS content,
                    ${slotDeletedIn(sql, forkId, "s")} AS deleted
                  FROM slots s WHERE s.chain_id = ${piece.chainId} AND s.depth BETWEEN ${piece.lo} AND ${piece.hi}
                  ORDER BY s.depth`
          slots.push(...found)
        }
        return slots
      }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })))
    /** The texts `forkId` shows, in display order, without what it deleted. */
    const shows = (forkId: ForkId) =>
      Effect.map(display(forkId), (slots) => slots.filter((slot) => !slot.deleted).map((slot) => slot.content))

    return {
      display,
      writer,
      reader,
      userId,
      otherId,
      mira,
      theirs,
      chatId,
      main,
      append,
      entry,
      insertBody,
      insert,
      fork,
      shows
    }
  })

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    assert.isTrue(Exit.isFailure(exit), "refused")
    return Exit.isFailure(exit) ? String(exit.cause) : ""
  })

const run = <A, E>(body: (dataDir: string) => Effect.Effect<A, E, Database.Writer | Database.Reader>) => {
  const dataDir = tempDir("fork-insert")
  return body(dataDir).pipe(
    Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers }))
  )
}

describe("inserting messages in forks", () => {
  it.live("looks up only the shown run version by position on a fixed path", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* setup(dataDir)
        const { userId, chatId, main, reader, writer } = t
        const a = yield* t.append(main, null, "a", "human")
        const b = yield* t.append(main, a, "b", "human")
        yield* t.append(main, b, "later")
        const plain = yield* t.fork(main, b)
        const x = yield* t.insert(main, a, "inserted")
        const at = (forkId: ForkId, position: number) =>
          reader.ReadPathVersionAt({ userId, chatId, forkId, leafSlotId: b, position })
        const identity = (slotId: SlotId, forkId: ForkId) =>
          Effect.map(t.entry(slotId, forkId), ({ version: { id, speakerEntityId } }) => ({ id, speakerEntityId }))

        assert.deepStrictEqual(yield* at(main, 1), yield* identity(x, main))
        assert.deepStrictEqual(yield* at(plain, 1), yield* identity(b, plain))
        assert.isNull(yield* at(main, 3))
        assert.isNull(yield* at(plain, 2))

        const entry = yield* t.entry(b, main)
        yield* writer.AmendVersion({
          userId,
          forkId: main,
          versionId: entry.version.id,
          content: "amended",
          expectedRowVersion: entry.rowVersion
        })
        assert.notStrictEqual((yield* at(main, 2))?.id, entry.version.id)
        assert.deepStrictEqual(yield* at(main, 2), yield* identity(b, main))
        yield* writer.SetSlotHidden({ userId, forkId: main, slotId: x, hidden: true })
        yield* writer.DeleteMessage({ userId, forkId: main, slotId: a })
        assert.isNull(yield* at(main, 0))
        assert.isNull(yield* at(main, 1))
        assert.deepStrictEqual(yield* at(plain, 0), yield* identity(a, plain))
      })
    )
  )

  it.live(
    "opens the fork through an Around target beyond an explicitly named leaf",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const a = yield* t.append(t.main, null, "a", "human")
          const b = yield* t.append(t.main, a, "b")
          const plain = yield* t.fork(t.main, b)
          const x = yield* t.insert(t.main, a, "x")
          // The oracle only checks whole fork paths. A named leaf truncates a read's
          // path even when the requested target is on the same fork beyond that leaf.
          for (const [forkId, leafSlotId, target] of [
            [t.main, a, x],
            [plain, a, x],
            [t.main, a, b],
            [t.main, x, b]
          ] as const) {
            const found = yield* t.reader.ReadPath({
              userId: t.userId,
              chatId: t.chatId,
              forkId,
              leafSlotId,
              range: { _tag: "Around", slot: target },
              limit: 3
            })
            assert.strictEqual(found.forkId, t.main)
            assert.strictEqual(found.leafSlotId, b)
            assert.deepStrictEqual(
              found.entries.map((e) => [e.slotId, e.position]),
              [
                [a, 0],
                [x, 1],
                [b, 2]
              ]
            )
          }
        })
      ),
    60_000
  )

  it.live(
    "serializes two tabs inserting at a generating anchor without moving the tip or changing another fork",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const a = yield* t.append(t.main, null, "a", "human")
          const b = yield* t.append(t.main, a, "b")
          const other = yield* t.fork(t.main, b)
          const running = yield* t.writer.AddVersion({
            userId: t.userId,
            slotId: b,
            forkId: t.main,
            version: said(t.mira, "partial reply", "model", "generating"),
            select: true,
            commitDraft: null
          })
          const seen = (yield* t.entry(b, t.main)).rowVersion
          const [first, second] = yield* Effect.all(
            ["tab one", "tab two"].map((content) =>
              t.insertBody(t.main, b, { _tag: "Write", speaker: t.mira, content }, seen)
            ),
            { concurrency: "unbounded" }
          )
          assert.isDefined(first)
          assert.isDefined(second)
          const newest = [first!, second!].sort((x, y) => y.slotId.localeCompare(x.slotId))
          assert.deepStrictEqual(yield* t.shows(t.main), [
            "a",
            "partial reply",
            ...newest.map((r) => r.version.content)
          ])
          assert.strictEqual((yield* t.entry(b, t.main)).version.id, running.id)
          assert.strictEqual((yield* t.entry(b, t.main)).version.status, "generating")
          assert.deepStrictEqual(yield* t.shows(other), ["a", "b"])
          // Both operations were accepted against the same row version, and neither
          // changed the structural tip used by the next append.
          yield* t.append(t.main, b, "after the insertions", "human")
          assert.deepStrictEqual(yield* t.shows(t.main), [
            "a",
            "partial reply",
            ...newest.map((r) => r.version.content),
            "after the insertions"
          ])
        })
      ),
    60_000
  )

  it.live(
    "rolls back the version and chat state when an insertion's attachment is refused",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const a = yield* t.append(t.main, null, "a", "human")
          const snapshot = () =>
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql`SELECT state_seq, row_version, current_fork_id, last_message_at,
              (SELECT count(*) FROM slots) AS slots, (SELECT count(*) FROM versions) AS versions
              FROM chats WHERE id = ${t.chatId}`
            }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })))
          const before = yield* snapshot()
          // insertVersion writes a row before checking attachment ownership. A refusal
          // here must roll that write back, along with every other part of the operation.
          assert.include(
            yield* failure(
              t.insertBody(t.main, a, {
                _tag: "Write",
                speaker: t.mira,
                content: "refused",
                images: [{ mediaId: "missing-media" }]
              })
            ),
            "NotFound"
          )
          assert.deepStrictEqual(yield* snapshot(), before)
          assert.deepStrictEqual(yield* t.shows(t.main), ["a"])
        })
      ),
    60_000
  )

  it.live(
    "shows an insertion in its fork and in forks made from it later, never in one made before or beside it",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const m0 = yield* t.append(t.main, null, "m0", "human")
          const a = yield* t.append(t.main, m0, "a")
          const b = yield* t.append(t.main, a, "b", "human")
          const c = yield* t.append(t.main, b, "c")
          const before = yield* t.fork(t.main, b)
          const beside = yield* t.fork(t.main, c)

          const x1 = yield* t.insert(t.main, a, "x1")
          const x2 = yield* t.insert(t.main, a, "x2")
          const x3 = yield* t.insert(t.main, x1, "x3")
          assert.deepStrictEqual(yield* t.shows(t.main), ["m0", "a", "x2", "x1", "x3", "b", "c"])
          // Made before, and beside at the same tip: untouched.
          assert.deepStrictEqual(yield* t.shows(before), ["m0", "a", "b"])
          assert.deepStrictEqual(yield* t.shows(beside), ["m0", "a", "b", "c"])

          // Made after, each ends where it was made, as main showed it.
          const atA = yield* t.fork(t.main, a)
          const atX1 = yield* t.fork(t.main, x1)
          const atX2 = yield* t.fork(t.main, x2)
          const atB = yield* t.fork(t.main, b)
          const atNull = yield* t.fork(t.main, null)
          assert.deepStrictEqual(yield* t.shows(atA), ["m0", "a"])
          assert.deepStrictEqual(yield* t.shows(atX1), ["m0", "a", "x2", "x1"])
          assert.deepStrictEqual(yield* t.shows(atX2), ["m0", "a", "x2"])
          assert.deepStrictEqual(yield* t.shows(atB), ["m0", "a", "x2", "x1", "x3", "b"])
          assert.deepStrictEqual(yield* t.shows(atNull), [])

          // A fork at an inserted slot appends below it; inserting there doesn't reach main.
          const reply = yield* t.append(atX1, x1, "after x1")
          assert.strictEqual((yield* t.entry(reply, atX1)).parentSlotId, x1)
          yield* t.insert(atX1, a, "x4")
          assert.deepStrictEqual(yield* t.shows(atX1), ["m0", "a", "x4", "x2", "x1", "after x1"])
          // Forked again at A from that fork: X₁ is structural there and inherited as an
          // insertion, and must not come back below A (the case spec §2.4 first missed).
          const atAagain = yield* t.fork(atX1, a)
          assert.deepStrictEqual(yield* t.shows(atAagain), ["m0", "a"])
          const atX4 = yield* t.fork(atX1, x2)
          assert.deepStrictEqual(yield* t.shows(atX4), ["m0", "a", "x4", "x2"])

          // Appending in main after an insertion goes after it, and changes no other fork.
          yield* t.append(t.main, c, "d")
          yield* t.insert(t.main, null, "top")
          assert.deepStrictEqual(yield* t.shows(t.main), ["top", "m0", "a", "x2", "x1", "x3", "b", "c", "d"])
          assert.deepStrictEqual(yield* t.shows(atB), ["m0", "a", "x2", "x1", "x3", "b"])
          assert.deepStrictEqual(yield* t.shows(beside), ["m0", "a", "b", "c"])
          assert.deepStrictEqual(yield* t.shows(before), ["m0", "a", "b"])
          // Inserting at the display end of a fork whose tip it is.
          yield* t.insert(atB, b, "end")
          assert.deepStrictEqual(yield* t.shows(atB), ["m0", "a", "x2", "x1", "x3", "b", "end"])
          yield* t.append(atB, b, "after end")
          assert.deepStrictEqual(yield* t.shows(atB), ["m0", "a", "x2", "x1", "x3", "b", "end", "after end"])

          // A branch from an inserted message in a fork that doesn't show it is made from one
          // that does (`forkThrough` reads display paths).
          const branched = yield* t.writer.AppendMessage({
            userId: t.userId,
            chatId: t.chatId,
            forkId: before,
            parentSlotId: x3,
            branch: true,
            version: said(t.mira, "below x3"),
            commitDraft: null
          })
          assert.notStrictEqual(branched.forkId, before)
          assert.deepStrictEqual(yield* t.shows(branched.forkId), ["m0", "a", "x2", "x1", "x3", "below x3"])

          // Amending an inserted message another fork shows gives this fork a copy.
          const amended = yield* t.entry(x2, t.main)
          yield* t.writer.AmendVersion({
            userId: t.userId,
            versionId: amended.version.id,
            forkId: t.main,
            content: "x2 amended",
            expectedRowVersion: amended.rowVersion
          })
          assert.include(yield* t.shows(t.main), "x2 amended")
          assert.include(yield* t.shows(atB), "x2")
          assert.notInclude(yield* t.shows(atB), "x2 amended")
        })
      ),
    60_000
  )

  it.live(
    "never lists an inserted message among the alternates, and lists it alone at its place",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const m0 = yield* t.append(t.main, null, "m0", "human")
          const a = yield* t.append(t.main, m0, "a")
          const b = yield* t.append(t.main, a, "b", "human")
          const x = yield* t.insert(t.main, a, "x")
          const top = yield* t.insert(t.main, null, "top")
          const branches = (slotId: SlotId) =>
            Effect.map(t.reader.ListBranches({ userId: t.userId, slotId, forkId: t.main }), (found) =>
              found.map((branch) => branch.slotId)
            )
          assert.deepStrictEqual(yield* branches(b), [b])
          assert.deepStrictEqual(yield* branches(m0), [m0])
          assert.deepStrictEqual(yield* branches(x), [x])
          assert.deepStrictEqual(yield* branches(top), [top])
          const counted = yield* t.entry(b, t.main)
          assert.deepStrictEqual([counted.branchCount, counted.branchIndex], [1, 0])
          const inserted = yield* t.entry(x, t.main)
          assert.deepStrictEqual([inserted.branchCount, inserted.branchIndex], [1, 0])
          yield* failure(
            t.writer.SwitchBranch({ userId: t.userId, chatId: t.chatId, slotId: b, index: 1, forkId: t.main })
          )
          yield* failure(
            t.writer.SwitchBranch({ userId: t.userId, chatId: t.chatId, slotId: x, index: 1, forkId: t.main })
          )
          // A real alternate is still counted beside the inserted one.
          const alternate = yield* t.writer.AppendMessage({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.main,
            parentSlotId: a,
            branch: true,
            version: said(t.mira, "b2", "human"),
            commitDraft: null
          })
          assert.deepStrictEqual(yield* branches(b), [b, alternate.slotId])
          const switched = yield* t.writer.SwitchBranch({
            userId: t.userId,
            chatId: t.chatId,
            slotId: b,
            index: 0,
            forkId: alternate.forkId
          })
          assert.strictEqual(switched.slotId, b)
          assert.strictEqual(switched.fork.id, t.main)
        })
      ),
    60_000
  )

  it.live(
    "refuses another user's speaker, chat or fork, and an anchor the fork no longer shows",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const m0 = yield* t.append(t.main, null, "m0", "human")
          const a = yield* t.append(t.main, m0, "a")
          const b = yield* t.append(t.main, a, "b", "human")
          const side = yield* t.fork(t.main, m0)
          const s1 = yield* t.append(side, m0, "s1")

          assert.include(yield* failure(t.insert(t.main, a, "theirs", t.theirs)), "NotFound")
          assert.include(
            yield* failure(
              t.writer.InsertMessage({
                userId: t.otherId,
                chatId: t.chatId,
                forkId: t.main,
                anchorSlotId: a,
                expectedRowVersion: 1,
                body: { _tag: "Write", speaker: null, content: "x" }
              })
            ),
            "NotFound"
          )
          // An anchor on another fork's path only.
          assert.include(yield* failure(t.insert(t.main, s1, "x", null)), "StaleWrite")
          // A deleted anchor (a tab that hadn't seen the deletion).
          const seen = (yield* t.entry(a, t.main)).rowVersion
          yield* t.writer.DeleteMessage({ userId: t.userId, slotId: a, forkId: t.main })
          assert.include(
            yield* failure(t.insertBody(t.main, a, { _tag: "Write", speaker: null, content: "x" }, seen)),
            "StaleWrite"
          )
          // Still shown in the fork beside it, which can insert there.
          yield* t.insert(side, m0, "fine")
          // A neighbour inserted since is no conflict: the older row version still inserts.
          const old = (yield* t.entry(b, t.main)).rowVersion
          yield* t.insert(t.main, b, "first")
          yield* t.insertBody(t.main, b, { _tag: "Write", speaker: null, content: "second" }, old)
          assert.deepStrictEqual(yield* t.shows(t.main), ["m0", "b", "second", "first"])
          assert.deepStrictEqual(yield* t.shows(side), ["m0", "fine", "s1"])
          // Nothing was written by the refusals.
          assert.notInclude(yield* t.shows(t.main), "theirs")
        })
      ),
    60_000
  )

  it.live(
    "duplicates the version a fork shows, keeping its writer, and refuses one still generating or failed",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const m0 = yield* t.append(t.main, null, "hello", "human")
          const a = yield* t.append(t.main, m0, "a reply")
          const b = yield* t.append(t.main, a, "go on", "human")
          const other = yield* t.fork(t.main, b)
          // Amended in main while `other` shows it: main shows its copy.
          const hello = yield* t.entry(m0, t.main)
          yield* t.writer.AmendVersion({
            userId: t.userId,
            versionId: hello.version.id,
            forkId: t.main,
            content: "hello there",
            expectedRowVersion: hello.rowVersion
          })
          const copy = (yield* t.entry(m0, t.main)).version
          assert.strictEqual(copy.content, "hello there")
          const made = yield* t.insertBody(t.main, m0, { _tag: "Duplicate", versionId: copy.id })
          assert.deepStrictEqual(
            [made.version.content, made.version.origin, made.version.writer, made.position],
            ["hello there", "duplicate", "human", 1]
          )
          assert.deepStrictEqual(yield* t.shows(t.main), ["hello there", "hello there", "a reply", "go on"])
          assert.deepStrictEqual(yield* t.shows(other), ["hello", "a reply", "go on"])

          // A model reply stays model-written: editing the duplicate adds a version.
          const reply = (yield* t.entry(a, t.main)).version
          const dup = yield* t.insertBody(t.main, a, { _tag: "Duplicate", versionId: reply.id })
          assert.deepStrictEqual(
            [dup.version.writer, dup.version.origin, dup.version.content, dup.version.speakerEntityId],
            ["model", "duplicate", "a reply", t.mira]
          )
          yield* failure(
            t.writer.AmendVersion({
              userId: t.userId,
              versionId: dup.version.id,
              forkId: t.main,
              content: "changed",
              expectedRowVersion: (yield* t.entry(dup.slotId, t.main)).rowVersion
            })
          )
          const edited = yield* t.writer.AddVersion({
            userId: t.userId,
            slotId: dup.slotId,
            forkId: t.main,
            version: new NewVersion({
              ...said(t.mira, "edited", "human"),
              origin: "edited",
              sourceVersionId: dup.version.id
            }),
            select: true,
            commitDraft: null
          })
          assert.strictEqual(edited.content, "edited")

          // A version the fork doesn't show at the anchor is stale; another slot's isn't found.
          const swipe = yield* t.writer.AddVersion({
            userId: t.userId,
            slotId: a,
            forkId: t.main,
            version: said(t.mira, "swipe"),
            select: false,
            commitDraft: null
          })
          assert.include(
            yield* failure(t.insertBody(t.main, a, { _tag: "Duplicate", versionId: swipe.id as VersionId })),
            "StaleWrite"
          )
          assert.include(
            yield* failure(t.insertBody(t.main, b, { _tag: "Duplicate", versionId: reply.id })),
            "NotFound"
          )
          // Generating and failed versions have nothing to copy yet.
          for (const status of ["generating", "failed"] as const) {
            const version = yield* t.writer.AddVersion({
              userId: t.userId,
              slotId: b,
              forkId: t.main,
              version: said(t.mira, status === "failed" ? "" : "partial", "model", status),
              select: true,
              commitDraft: null
            })
            assert.include(
              yield* failure(t.insertBody(t.main, b, { _tag: "Duplicate", versionId: version.id as VersionId })),
              "InsertRefused"
            )
          }
        })
      ),
    60_000
  )

  it.live(
    "keeps every fork's view through a 70-deep chain of forks",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          let previous = yield* t.append(t.main, null, "m0", "human")
          let current = t.main
          const expected = ["m0"]
          for (let i = 0; i < 70; i++) {
            const next = yield* t.append(current, previous, `m${i + 1}`)
            yield* t.insert(current, previous, `x${i}`)
            expected.push(`m${i + 1}`)
            expected.splice(expected.length - 1, 0, `x${i}`)
            current = yield* t.fork(current, next)
            previous = next
          }
          assert.deepStrictEqual(yield* t.shows(current), expected)
          // Deep in the chain, a fork at a message still leaves its gap behind.
          const anchor = (yield* t.entry(previous, current)).parentSlotId!
          const atAnchor = yield* t.fork(current, anchor)
          assert.deepStrictEqual(yield* t.shows(atAnchor), expected.slice(0, -2))
          assert.deepStrictEqual(yield* t.shows(t.main), ["m0", "x0", "m1"])
        })
      ),
    { timeout: 120_000, tags: ["slow"] }
  )

  it.live(
    "reads a fork's path by position: windows page through it in both directions without gaps or repeats",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const ms: Array<SlotId> = []
          let previous: SlotId | null = null
          for (let i = 0; i < 10; i++) {
            previous = yield* t.append(t.main, previous, `m${i}`, i % 2 ? "model" : "human")
            ms.push(previous)
          }
          const plain = yield* t.fork(t.main, ms[9]!)
          yield* t.insert(t.main, ms[2]!, "x1")
          const x2 = yield* t.insert(t.main, ms[2]!, "x2")
          yield* t.insert(t.main, x2, "x3")
          yield* t.insert(t.main, null, "top")
          const x5 = yield* t.insert(t.main, ms[5]!, "x5")
          const gone = yield* t.insert(t.main, ms[7]!, "gone")
          yield* t.writer.DeleteMessage({ userId: t.userId, slotId: gone, forkId: t.main })
          const end = yield* t.insert(t.main, ms[9]!, "end")

          const all = yield* t.display(t.main)
          const shown = all.filter((slot) => !slot.deleted).map((slot) => slot.id)
          const positions = new Map(all.map((slot, i) => [slot.id as string, i]))
          assert.deepStrictEqual(
            (yield* t.shows(t.main)).join(" "),
            "top m0 m1 m2 x2 x3 x1 m3 m4 m5 x5 m6 m7 m8 m9 end"
          )
          const check = (entries: ReadonlyArray<{ slotId: SlotId; position?: number | undefined }>) => {
            for (const entry of entries) assert.strictEqual(entry.position, positions.get(entry.slotId), entry.slotId)
          }

          // GetPath, paging back from the display end.
          for (const limit of [1, 2, 3, 7, 100]) {
            const ids: Array<SlotId> = []
            let leaf: SlotId | null = null
            let first = true
            while (first || leaf !== null) {
              first = false
              const window: Effect.Success<ReturnType<typeof t.reader.GetPath>> = yield* t.reader.GetPath({
                userId: t.userId,
                chatId: t.chatId,
                forkId: t.main,
                leafSlotId: leaf,
                limit
              })
              check(window.entries)
              // Appends go below the tip, m9, not below the message inserted after it.
              assert.strictEqual(window.tipSlotId, ms[9])
              ids.unshift(...window.entries.map((e) => e.slotId))
              leaf = window.olderLeafSlotId
            }
            assert.deepStrictEqual(ids, shown, `GetPath by ${limit}`)
          }

          // ReadPath: older from the bottom, newer from around a slot, both ways from it.
          const read = (range: Parameters<typeof t.reader.ReadPath>[0]["range"], limit: number) =>
            t.reader.ReadPath({ userId: t.userId, chatId: t.chatId, forkId: t.main, leafSlotId: null, range, limit })
          for (const limit of [1, 3, 5]) {
            const ids: Array<SlotId> = []
            let window = yield* read({ _tag: "Bottom" }, limit)
            // The client's leaf, which it appends below: the tip, not the inserted display end.
            assert.strictEqual(window.leafSlotId, ms[9])
            ids.unshift(...window.entries.map((e) => e.slotId))
            while (window.older !== null) {
              window = yield* read({ _tag: "Older", from: window.older }, limit)
              check(window.entries)
              ids.unshift(...window.entries.map((e) => e.slotId))
            }
            assert.deepStrictEqual(ids, shown, `Older by ${limit}`)

            const around = yield* read({ _tag: "Around", slot: x5 }, limit)
            check(around.entries)
            assert.include(
              around.entries.map((e) => e.slotId),
              x5
            )
            const both = around.entries.map((e) => e.slotId)
            let down = around
            while (down.newer !== null) {
              down = yield* read({ _tag: "Newer", after: down.newer }, limit)
              check(down.entries)
              both.push(...down.entries.map((e) => e.slotId))
            }
            let up = around
            while (up.older !== null) {
              up = yield* read({ _tag: "Older", from: up.older }, limit)
              both.unshift(...up.entries.map((e) => e.slotId))
            }
            assert.deepStrictEqual(both, shown, `Around and Newer by ${limit}`)
          }
          // Around a slot this fork doesn't show opens a fork that does.
          const elsewhere = yield* t.reader.ReadPath({
            userId: t.userId,
            chatId: t.chatId,
            forkId: plain,
            leafSlotId: null,
            range: { _tag: "Around", slot: x5 },
            limit: 3
          })
          assert.strictEqual(elsewhere.forkId, t.main)
          assert.deepStrictEqual(
            elsewhere.entries.map((e) => e.slotId),
            [ms[5]!, x5, ms[6]!]
          )

          // A fork without insertions numbers by depth, as before.
          const plainPath = yield* t.reader.GetPath({
            userId: t.userId,
            chatId: t.chatId,
            forkId: plain,
            leafSlotId: null,
            limit: 100
          })
          assert.deepStrictEqual(
            plainPath.entries.map((e) => [e.slotId, e.position]),
            ms.map((id, i) => [id, i])
          )

          // The forks' tip texts are the last message each shows.
          const tips = (yield* t.reader.ListForks({ userId: t.userId, chatId: t.chatId })).map((f) => [
            f.id,
            f.tipExcerpt
          ])
          assert.deepInclude(tips, [t.main, "end"])
          assert.deepInclude(tips, [plain, "m9"])
          yield* t.writer.DeleteMessage({ userId: t.userId, slotId: end, forkId: t.main })
          assert.deepInclude(
            (yield* t.reader.ListForks({ userId: t.userId, chatId: t.chatId })).map((f) => [f.id, f.tipExcerpt]),
            [t.main, "m9"]
          )
        })
      ),
    120_000
  )
})
