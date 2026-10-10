// The message graph through the real storage operations (writer and reader workers):
// DESIGN §3, DATA-MODEL §4–§5 and invariants 2–4.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"

const database = () =>
  Database.layer({
    dataDir: mkdtempSync(join(tmpdir(), "rp-graph-")),
    readers: 2,
    allowNetworkFs: false,
    workers: "source"
  })

const say = (
  speaker: EntityId,
  content: string,
  overrides: Partial<ConstructorParameters<typeof NewVersion>[0]> = {}
) =>
  new NewVersion({
    speakerEntityId: speaker,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written",
    ...overrides
  })

const generated = (speaker: EntityId, content: string) =>
  say(speaker, content, { writer: "model", origin: "generated" })

/** A user with two cards (Mira, and "Me" as a persona) and an active chat greeted by Mira. */
const setup = (handle = "ana") =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const user = yield* writer.EnsureUser({ handle, displayName: handle })
    const card = (name: string) =>
      writer
        .CreateEntity({
          userId: user.id,
          kind: "card",
          label: name,
          subtitle: "",
          doc: { name },
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        .pipe(Effect.map((e) => e.entityId))
    const mira = yield* card("Mira")
    const me = yield* card("Me")
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Harbor",
      participants: [mira, me],
      greeting: say(mira, "The harbor bell rings twice.", { origin: "greeting", macroMode: "template" })
    })
    const append = (parentSlotId: SlotId | null, version: NewVersion) =>
      writer.AppendMessage({ userId: user.id, chatId: chat.id, parentSlotId, version, commitDraft: null })
    const path = (leafSlotId: SlotId | null = null) =>
      reader.GetPath({ userId: user.id, chatId: chat.id, leafSlotId, limit: 1000 }).pipe(Effect.map((w) => w.entries))
    const stateAt = (slotId: SlotId | null) =>
      reader.StateEventsAt({ userId: user.id, chatId: chat.id, slotId }).pipe(Effect.map(foldState))
    return { writer, reader, userId: user.id as UserId, mira, me, chat, append, path, stateAt }
  })

describe("message graph", () => {
  it.live("a path runs from the root to the leaf, each slot showing its selection", () =>
    Effect.gen(function* () {
      const { me, mira, chat, append, path } = yield* setup()
      const greeting = chat.activeLeafSlotId!
      const a = yield* append(greeting, say(me, "Who rang it?"))
      const b = yield* append(a.slotId, generated(mira, "Nobody you'd know."))
      const entries = yield* path()
      assert.deepStrictEqual(
        entries.map((e) => e.version.content),
        ["The harbor bell rings twice.", "Who rang it?", "Nobody you'd know."]
      )
      assert.deepStrictEqual(
        entries.map((e) => e.depth),
        [0, 1, 2]
      )
      assert.strictEqual(b.chat.activeLeafSlotId, b.slotId)
    }).pipe(Effect.provide(database()))
  )

  it.live("a swipe replaces a message in place and keeps what follows (DESIGN §3.1, invariant 3)", () =>
    Effect.gen(function* () {
      const { writer, userId, me, mira, chat, append, path } = yield* setup()
      const a = yield* append(chat.activeLeafSlotId!, generated(mira, "first take"))
      yield* append(a.slotId, say(me, "and then?"))
      const before = yield* path()

      const swipe = yield* writer.AddVersion({
        userId,
        slotId: a.slotId,
        version: generated(mira, "second take"),
        select: true,
        commitDraft: null
      })
      const after = yield* path()

      assert.deepStrictEqual(
        after.map((e) => e.version.content),
        ["The harbor bell rings twice.", "second take", "and then?"]
      )
      assert.strictEqual(after[1]!.versionCount, 2)
      assert.strictEqual(swipe.ordinal, 1)
      // Only the swiped slot changed.
      for (const i of [0, 2]) assert.deepStrictEqual(after[i], before[i])
    }).pipe(Effect.provide(database()))
  )

  it.live("a branch keeps both continuations, and state after the fork doesn't leak (invariant 4)", () =>
    Effect.gen(function* () {
      const { writer, userId, me, mira, chat, append, path, stateAt } = yield* setup()
      const fork = yield* append(chat.activeLeafSlotId!, say(me, "Let's go to the lighthouse."))
      const main = yield* append(fork.slotId, generated(mira, "The lighthouse it is."))
      const note = yield* writer.CreateEntity({
        userId,
        kind: "note",
        label: "Outfit",
        subtitle: "",
        doc: { content: "Raincoat" },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })

      // Before the fork: visible on both branches. After it, on the main branch only.
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        slotId: fork.slotId,
        versionId: null,
        scope: null,
        data: { key: "var.set", value: { name: "weather", value: "rain" } },
        origin: "user"
      })
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        slotId: main.slotId,
        versionId: null,
        scope: null,
        data: { key: "note.activate", value: { note: note.entityId } },
        origin: "user"
      })

      const branch = yield* append(fork.slotId, generated(mira, "The market, then."))
      assert.strictEqual(branch.chat.activeLeafSlotId, branch.slotId)

      const mainState = yield* stateAt(main.slotId)
      const branchState = yield* stateAt(branch.slotId)
      assert.deepStrictEqual(mainState.activeNotes, [note.entityId])
      assert.deepStrictEqual(branchState.activeNotes, [])
      assert.deepStrictEqual(branchState.vars, { weather: "rain" })
      assert.deepStrictEqual(branchState.participants, [mira, me])

      // Both continuations exist, each on its own path.
      assert.strictEqual((yield* path(main.slotId)).at(-1)!.version.content, "The lighthouse it is.")
      assert.strictEqual((yield* path(branch.slotId)).at(-1)!.version.content, "The market, then.")
    }).pipe(Effect.provide(database()))
  )

  it.live("state attached to a version switches with the selection (DESIGN §3.4, §7.3)", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, mira, me, chat, append, stateAt } = yield* setup()
      const turn = yield* append(chat.activeLeafSlotId!, generated(mira, "Mira stays."))
      const leaves = yield* writer.AddVersion({
        userId,
        slotId: turn.slotId,
        version: generated(mira, "Mira leaves."),
        select: true,
        commitDraft: null
      })
      // The rollout that wrote "Mira leaves." also marked her absent.
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        slotId: turn.slotId,
        versionId: leaves.id,
        scope: null,
        data: { key: "presence.set", value: { entity: mira, present: false } },
        origin: "rollout"
      })
      assert.deepStrictEqual((yield* stateAt(turn.slotId)).absent, [mira])

      const [slot] = (yield* reader.GetPath({
        userId,
        chatId: chat.id,
        leafSlotId: turn.slotId,
        limit: 1
      })).entries.slice(-1)
      yield* writer.SelectVersion({
        userId,
        slotId: turn.slotId,
        versionId: turn.version.id,
        expectedRowVersion: slot!.rowVersion
      })
      assert.deepStrictEqual((yield* stateAt(turn.slotId)).absent, [])
      assert.deepStrictEqual((yield* stateAt(turn.slotId)).participants, [mira, me])
    }).pipe(Effect.provide(database()))
  )

  it.live("failed and empty selections stay out of the context (invariant 2)", () =>
    Effect.gen(function* () {
      const { writer, userId, mira, chat, append, path } = yield* setup()
      const turn = yield* append(chat.activeLeafSlotId!, generated(mira, "fine"))
      yield* writer.AddVersion({
        userId,
        slotId: turn.slotId,
        select: true,
        version: new NewVersion({
          ...generated(mira, ""),
          status: "failed",
          error: { class: "refusal", message: "content filter" }
        }),
        commitDraft: null
      })
      const streaming = yield* append(turn.slotId, new NewVersion({ ...generated(mira, ""), status: "generating" }))
      const entries = yield* path(streaming.slotId)
      assert.deepStrictEqual(
        entries.map((e) => [e.version.status, e.inContext]),
        [
          ["complete", true],
          ["failed", false],
          ["generating", false]
        ]
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("a selection from a stale view is refused (DATA-MODEL §10)", () =>
    Effect.gen(function* () {
      const { writer, userId, mira, chat, append, path } = yield* setup()
      const turn = yield* append(chat.activeLeafSlotId!, generated(mira, "one"))
      const two = yield* writer.AddVersion({
        userId,
        slotId: turn.slotId,
        version: generated(mira, "two"),
        select: false,
        commitDraft: null
      })
      const seen = (yield* path()).at(-1)!.rowVersion

      const ok = yield* writer.SelectVersion({
        userId,
        slotId: turn.slotId,
        versionId: two.id,
        expectedRowVersion: seen
      })
      assert.strictEqual(ok.rowVersion, seen + 1)

      // A second tab still holding the old row version.
      const stale = yield* writer
        .SelectVersion({ userId, slotId: turn.slotId, versionId: turn.version.id, expectedRowVersion: seen })
        .pipe(Effect.flip)
      assert.strictEqual(stale._tag, "StaleWrite")
      assert.strictEqual((yield* path()).at(-1)!.version.content, "two")
    }).pipe(Effect.provide(database()))
  )

  it.live("users can't see or touch each other's chats or cards (DATA-MODEL §1, principle 6)", () =>
    Effect.gen(function* () {
      const ana = yield* setup("ana")
      const bob = yield* setup("bob")
      const notFound = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((e) => e._tag)
        )

      assert.strictEqual(
        yield* notFound(ana.reader.GetPath({ userId: bob.userId, chatId: ana.chat.id, leafSlotId: null, limit: 10 })),
        "NotFound"
      )
      assert.strictEqual(
        yield* notFound(
          bob.writer.AppendMessage({
            userId: bob.userId,
            chatId: ana.chat.id,
            parentSlotId: null,
            version: say(bob.me, "hi"),
            commitDraft: null
          })
        ),
        "NotFound"
      )
      // Bob can't make Ana's card speak in his own chat.
      assert.strictEqual(yield* notFound(bob.append(bob.chat.activeLeafSlotId!, say(ana.mira, "borrowed"))), "NotFound")
      assert.strictEqual(
        yield* notFound(bob.reader.ListVersions({ userId: bob.userId, slotId: ana.chat.activeLeafSlotId! })),
        "NotFound"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("the first message turns a pending chat active (DESIGN §2.1)", () =>
    Effect.gen(function* () {
      const { writer, userId, mira, me } = yield* setup()
      const pending = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "pending",
        title: "",
        participants: [mira, me],
        greeting: say(mira, "Hello, {{user}}.", { origin: "greeting", macroMode: "template" })
      })
      assert.strictEqual(pending.status, "pending")
      assert.strictEqual(pending.lastMessageAt, null)
      const sent = yield* writer.AppendMessage({
        userId,
        chatId: pending.id,
        parentSlotId: pending.activeLeafSlotId,
        version: say(me, "Hi, Mira."),
        commitDraft: null
      })
      assert.strictEqual(sent.chat.status, "active")
      assert.isNotNull(sent.chat.lastMessageAt)
    }).pipe(Effect.provide(database()))
  )

  it.live(
    "reads a long chat in windows whose cost doesn't depend on its length",
    () =>
      Effect.gen(function* () {
        const { reader, userId, me, mira, chat, append } = yield* setup()
        let leaf = chat.activeLeafSlotId!
        for (let i = 0; i < 2000; i++) {
          leaf = (yield* append(leaf, i % 2 === 0 ? say(me, `line ${i}`) : generated(mira, `reply ${i}`))).slotId
        }
        const window = (leafSlotId: SlotId | null, limit: number) =>
          reader.GetPath({ userId, chatId: chat.id, leafSlotId, limit })

        yield* window(null, 200) // warm the reader's statement cache
        const start = performance.now()
        const latest = yield* window(null, 200)
        const ms = performance.now() - start
        assert.strictEqual(latest.entries.length, 200)
        assert.strictEqual(latest.entries.at(-1)!.version.content, "reply 1999")
        assert.isTrue(latest.hasMore)
        assert.isBelow(ms, 40, `a 200-slot window took ${ms.toFixed(1)} ms`)

        // Paging back to the root reconstructs the whole path, in order, without gaps.
        const all = [...latest.entries]
        let page = latest
        while (page.hasMore) {
          page = yield* window(page.entries[0]!.parentSlotId, 500)
          all.unshift(...page.entries)
        }
        assert.strictEqual(all.length, 2001)
        assert.deepStrictEqual(
          all.map((e) => e.depth),
          all.map((_, i) => i)
        )
      }).pipe(Effect.provide(database())),
    120_000
  )
})
