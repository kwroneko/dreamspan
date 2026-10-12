// The message graph through the real storage operations (writer and reader workers):
// DESIGN §3, DATA-MODEL §4–§5 and invariants 2–4.
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { EntityKind } from "@rp/shared/library.ts"
import type { ConnectionId } from "@rp/shared/providers.ts"
import { foldState, type StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { pathWindow } from "../src/db/reads.ts"
import { tempDir } from "./support/tempDir.ts"

const database = (dataDir = tempDir("graph")) =>
  Database.layer({ dataDir, readers: 2, allowNetworkFs: false, workers: "source" })

const windowProbe = fileURLToPath(new URL("./support/windowProbe.ts", import.meta.url))

/** Runs support/windowProbe.ts in a child process, killed if it makes no progress in 20 s. */
const probeWindow = (...args: Array<string>) =>
  Effect.callback<string, Error>((resume) => {
    const child = execFile(
      process.execPath,
      [windowProbe, ...args],
      { timeout: 20_000, killSignal: "SIGKILL" },
      (error, stdout, stderr) =>
        resume(
          error === null
            ? Effect.succeed(stdout)
            : Effect.fail(
                new Error(
                  error.killed
                    ? "no progress in 20 s: the window read walked past its limit into the cycle"
                    : `${error.message}\n${stderr}`
                )
              )
        )
    )
    return Effect.sync(() => child.kill("SIGKILL"))
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
    const entity = (name: string, kind: EntityKind = "card") =>
      writer.CreateEntity({
        userId: user.id,
        kind,
        label: name,
        subtitle: "",
        doc: { name },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const mira = (yield* entity("Mira")).entityId
    const me = (yield* entity("Me")).entityId
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Harbor",
      participants: [mira, me],
      greeting: say(mira, "The harbor bell rings twice.", { origin: "greeting", macroMode: "template" })
    })
    const append = (parentSlotId: SlotId | null, version: NewVersion, branch = false) =>
      writer.AppendMessage({ userId: user.id, chatId: chat.id, parentSlotId, branch, version, commitDraft: null })
    const path = (leafSlotId: SlotId | null = null) =>
      reader.GetPath({ userId: user.id, chatId: chat.id, leafSlotId, limit: 1000 }).pipe(Effect.map((w) => w.entries))
    const stateAt = (slotId: SlotId | null) =>
      reader.StateEventsAt({ userId: user.id, chatId: chat.id, slotId }).pipe(Effect.map(foldState))
    const addState = (
      slotId: SlotId | null,
      data: StateEventData,
      versionId: VersionId | null = null,
      chatId = chat.id
    ) => writer.AddStateEvent({ userId: user.id, chatId, slotId, versionId, scope: null, data })
    return { writer, reader, userId: user.id as UserId, entity, mira, me, chat, append, path, stateAt, addState }
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
      const { entity, me, mira, chat, append, path, stateAt, addState } = yield* setup()
      const fork = yield* append(chat.activeLeafSlotId!, say(me, "Let's go to the lighthouse."))
      const main = yield* append(fork.slotId, generated(mira, "The lighthouse it is."))
      const note = yield* entity("Outfit", "note")

      // Before the fork: visible on both branches. After it, on the main branch only.
      yield* addState(fork.slotId, { key: "var.set", value: { name: "weather", value: "rain" } })
      yield* addState(main.slotId, { key: "note.activate", value: { note: note.entityId } })

      const branch = yield* append(fork.slotId, generated(mira, "The market, then."), true)
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
      const { writer, reader, userId, mira, me, chat, append, stateAt, addState } = yield* setup()
      const turn = yield* append(chat.activeLeafSlotId!, generated(mira, "Mira stays."))
      const leaves = yield* writer.AddVersion({
        userId,
        slotId: turn.slotId,
        version: generated(mira, "Mira leaves."),
        select: true,
        commitDraft: null
      })
      // Marked absent only on the swipe where she leaves.
      yield* addState(turn.slotId, { key: "presence.set", value: { entity: mira, present: false } }, leaves.id)
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
            branch: true,
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
        branch: false,
        version: say(me, "Hi, Mira."),
        commitDraft: null
      })
      assert.strictEqual(sent.chat.status, "active")
      assert.isNotNull(sent.chat.lastMessageAt)
    }).pipe(Effect.provide(database()))
  )

  it.live(
    "reads a long chat in windows, and paging back reconstructs the whole path",
    () =>
      Effect.gen(function* () {
        const { reader, userId, me, mira, chat, append } = yield* setup()
        let leaf = chat.activeLeafSlotId!
        for (let i = 0; i < 2000; i++) {
          leaf = (yield* append(leaf, i % 2 === 0 ? say(me, `line ${i}`) : generated(mira, `reply ${i}`))).slotId
        }
        const window = (leafSlotId: SlotId | null, limit: number) =>
          reader.GetPath({ userId, chatId: chat.id, leafSlotId, limit })

        // No time budget: on a loaded host a read can take any time, so the window's cost
        // is measured (ARCHITECTURE.md §3.8), not asserted.
        const latest = yield* window(null, 200)
        assert.strictEqual(latest.entries.length, 200)
        assert.strictEqual(latest.entries.at(-1)!.version.content, "reply 1999")
        assert.isNotNull(latest.olderLeafSlotId)

        // Paging back to the root reconstructs the whole path, in order, without gaps.
        const all = [...latest.entries]
        let page = latest
        while (page.olderLeafSlotId !== null) {
          page = yield* window(page.olderLeafSlotId, 500)
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

  it.live("pages past a run of deleted messages", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, me, chat, append } = yield* setup()
      let leaf = chat.activeLeafSlotId!
      const slots: Array<SlotId> = []
      for (let i = 0; i < 5; i++) slots.push((leaf = (yield* append(leaf, say(me, `line ${i}`))).slotId))
      for (const slotId of slots.slice(1, 4)) yield* writer.DeleteMessage({ userId, slotId })

      const contents: Array<string> = []
      const window = (leafSlotId: SlotId) => reader.GetPath({ userId, chatId: chat.id, leafSlotId, limit: 2 })
      let next: SlotId | null = leaf
      let pages = 0
      while (next !== null) {
        const page: Effect.Success<ReturnType<typeof window>> = yield* window(next)
        contents.unshift(...page.entries.map((e) => e.version.content))
        next = page.olderLeafSlotId
        pages++
      }
      assert.deepStrictEqual(contents, ["The harbor bell rings twice.", "line 0", "line 4"])
      assert.strictEqual(pages, 3) // one of them empty: two deleted messages
    }).pipe(Effect.provide(database()))
  )

  it.live("an append from a stale view is refused unless it's an explicit branch (DESIGN §3.2)", () =>
    Effect.gen(function* () {
      const { me, mira, chat, append, path } = yield* setup()
      const greeting = chat.activeLeafSlotId!
      const moved = yield* append(greeting, generated(mira, "sent from another tab"))
      // This tab still shows the greeting as the tip.
      const stale = yield* append(greeting, say(me, "Hello?")).pipe(Effect.flip)
      assert.strictEqual(stale._tag, "LeafMoved")
      assert.strictEqual(stale._tag === "LeafMoved" && stale.activeLeafSlotId, moved.slotId)
      assert.deepStrictEqual(
        (yield* path()).map((e) => e.version.content),
        ["The harbor bell rings twice.", "sent from another tab"]
      )
      const branch = yield* append(greeting, say(me, "Hello?"), true)
      assert.strictEqual(branch.chat.activeLeafSlotId, branch.slotId)
    }).pipe(Effect.provide(database()))
  )

  it.live("an edit's source is a live version of the same slot", () =>
    Effect.gen(function* () {
      const ana = yield* setup("ana")
      const bob = yield* setup("bob")
      const greeting = ana.chat.activeLeafSlotId!
      const [anaVersion] = yield* ana.reader.ListVersions({ userId: ana.userId, slotId: greeting })
      const edit = (slotId: SlotId, sourceVersionId: VersionId) =>
        bob.writer.AddVersion({
          userId: bob.userId,
          slotId,
          version: say(bob.mira, "edited", { origin: "edited", sourceVersionId }),
          select: true,
          commitDraft: null
        })
      // Another user's version, or one from another slot or in the bin, isn't a source.
      assert.strictEqual((yield* edit(bob.chat.activeLeafSlotId!, anaVersion!.id).pipe(Effect.flip))._tag, "NotFound")
      const reply = yield* bob.append(bob.chat.activeLeafSlotId!, generated(bob.mira, "reply"))
      assert.strictEqual((yield* edit(bob.chat.activeLeafSlotId!, reply.version.id).pipe(Effect.flip))._tag, "NotFound")
      const swipe = yield* bob.writer.AddVersion({
        userId: bob.userId,
        slotId: reply.slotId,
        version: generated(bob.mira, "swipe"),
        select: false,
        commitDraft: null
      })
      yield* bob.writer.DeleteVersion({ userId: bob.userId, versionId: swipe.id })
      assert.strictEqual((yield* edit(reply.slotId, swipe.id).pipe(Effect.flip))._tag, "NotFound")
      // A new message has no earlier version to come from.
      const appended = yield* bob
        .append(reply.slotId, say(bob.me, "x", { origin: "edited", sourceVersionId: reply.version.id }))
        .pipe(Effect.flip)
      assert.strictEqual(appended._tag, "NotFound")
      const ok = yield* edit(reply.slotId, reply.version.id)
      assert.strictEqual(ok.sourceVersionId, reply.version.id)

      // Ana can still delete her chat for good.
      const item = yield* ana.writer.DeleteChat({ userId: ana.userId, chatId: ana.chat.id })
      yield* ana.writer.PurgeBinItem({ userId: ana.userId, itemId: item.id })
    }).pipe(Effect.provide(database()))
  )

  it.live("a swipe in the recycle bin can't be selected", () =>
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
      yield* writer.DeleteVersion({ userId, versionId: two.id })
      const rowVersion = (yield* path()).at(-1)!.rowVersion
      const select = yield* writer
        .SelectVersion({ userId, slotId: turn.slotId, versionId: two.id, expectedRowVersion: rowVersion })
        .pipe(Effect.flip)
      assert.strictEqual(select._tag, "NotFound")
    }).pipe(Effect.provide(database()))
  )

  it.live("a state event names only the user's own things (DESIGN §11)", () =>
    Effect.gen(function* () {
      const ana = yield* setup("ana")
      const bob = yield* setup("bob")
      const [anaNote, anaLorebook, anaPreset] = yield* Effect.all([
        ana.entity("Outfit", "note"),
        ana.entity("World", "lorebook"),
        ana.entity("Style", "preset")
      ])
      const anaMira = (yield* ana.reader.ListLibrary({
        userId: ana.userId,
        kind: "card",
        tag: null,
        archived: false
      })).find((ref) => ref.entityId === ana.mira)!
      const connection = (userId: UserId) =>
        Effect.gen(function* () {
          const conn = yield* ana.writer.CreateConnection({
            userId,
            connectionId: uuidv7() as ConnectionId,
            kind: "openai-chat",
            api: "openai-completions",
            settings: {
              name: "Local",
              baseUrl: "http://127.0.0.1:8081/v1",
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            },
            credential: { existing: null }
          })
          const model = yield* ana.writer.AddUserModel({ userId, connectionId: conn.id, key: "m", overrides: {} })
          return { connection: conn.id, model: model.id }
        })
      const anaModel = yield* connection(ana.userId)
      const bobModel = yield* connection(bob.userId)
      const bobNote = yield* bob.entity("Outfit", "note")

      const refused: ReadonlyArray<StateEventData> = [
        { key: "participant.join", value: { entity: ana.mira } },
        { key: "presence.set", value: { entity: ana.mira, present: false } },
        { key: "played_by_me.set", value: { entities: [bob.me, ana.me] } },
        { key: "card.binding", value: { entity: ana.mira } },
        { key: "card.binding", value: { entity: bob.mira, ref: anaMira.id } },
        { key: "card.binding", value: { entity: bob.mira, revision: anaMira.headRevisionId } },
        { key: "note.activate", value: { note: anaNote.entityId } },
        { key: "note.binding", value: { note: bobNote.entityId, revision: anaNote.ref.headRevisionId } },
        { key: "author_note.set", value: { note: anaNote.entityId } },
        { key: "preset.binding", value: { ref: anaPreset.ref.id } },
        { key: "preset.binding", value: { revision: anaPreset.ref.headRevisionId } },
        { key: "lorebook.attach", value: { ref: anaLorebook.ref.id } },
        { key: "model.binding", value: anaModel },
        { key: "model.binding", value: { connection: bobModel.connection, model: anaModel.model } },
        // The right owner but the wrong kind.
        { key: "note.activate", value: { note: bob.mira } }
      ]
      for (const data of refused) {
        const error = yield* bob.addState(null, data).pipe(Effect.flip)
        assert.strictEqual(error._tag, "NotFound", JSON.stringify(data))
      }
      const created = yield* bob.writer
        .CreateChat({
          userId: bob.userId,
          kind: "rp",
          status: "active",
          title: "",
          participants: [ana.mira],
          greeting: null
        })
        .pipe(Effect.flip)
      assert.strictEqual(created._tag, "NotFound")

      // The same events with Bob's own things go through.
      yield* bob.addState(null, { key: "note.activate", value: { note: bobNote.entityId } })
      yield* bob.addState(null, { key: "model.binding", value: bobModel })
      const state = yield* bob.stateAt(null)
      assert.deepStrictEqual(state.participants, [bob.mira, bob.me])
      assert.deepStrictEqual(state.activeNotes, [bobNote.entityId])
    }).pipe(Effect.provide(database()))
  )

  it.live("state events sit on a live position of their chat", () =>
    Effect.gen(function* () {
      const ana = yield* setup("ana")
      const bob = yield* setup("bob")
      const weather = { key: "var.set", value: { name: "weather", value: "rain" } } as const
      const tag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((e) => e._tag)
        )
      const anaGreeting = ana.chat.activeLeafSlotId!
      const bobGreeting = bob.chat.activeLeafSlotId!
      const [anaVersion] = yield* ana.reader.ListVersions({ userId: ana.userId, slotId: anaGreeting })
      assert.strictEqual(yield* tag(bob.addState(anaGreeting, weather)), "NotFound")
      assert.strictEqual(yield* tag(bob.addState(bobGreeting, weather, anaVersion!.id)), "NotFound")
      assert.strictEqual(yield* tag(bob.addState(null, weather, anaVersion!.id)), "NotFound")
      assert.strictEqual(
        yield* tag(bob.reader.StateEventsAt({ userId: bob.userId, chatId: bob.chat.id, slotId: anaGreeting })),
        "NotFound"
      )

      const reply = yield* bob.append(bobGreeting, say(bob.me, "Let it rain."))
      yield* bob.writer.DeleteMessage({ userId: bob.userId, slotId: reply.slotId })
      assert.strictEqual(yield* tag(bob.addState(reply.slotId, weather)), "NotFound")
    }).pipe(Effect.provide(database()))
  )

  it.live("a deleted message's state stops applying until it's restored", () =>
    Effect.gen(function* () {
      const { writer, userId, me, mira, chat, append, stateAt, addState } = yield* setup()
      const turn = yield* append(chat.activeLeafSlotId!, say(me, "It starts to rain."))
      const reply = yield* append(turn.slotId, generated(mira, "Mira opens an umbrella."))
      yield* addState(turn.slotId, { key: "var.set", value: { name: "weather", value: "rain" } })
      assert.deepStrictEqual((yield* stateAt(reply.slotId)).vars, { weather: "rain" })

      const item = yield* writer.DeleteMessage({ userId, slotId: turn.slotId })
      assert.deepStrictEqual((yield* stateAt(reply.slotId)).vars, {})
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      assert.deepStrictEqual((yield* stateAt(reply.slotId)).vars, { weather: "rain" })
    }).pipe(Effect.provide(database()))
  )

  it.live("a deleted card can still be taken out of a chat, and a purged one stays out", () =>
    Effect.gen(function* () {
      const { writer, userId, entity, me, mira, chat, append, stateAt, addState } = yield* setup()
      const tomas = (yield* entity("Tomas")).entityId
      const ines = (yield* entity("Ines")).entityId
      yield* addState(null, { key: "participant.join", value: { entity: tomas } })
      yield* addState(null, { key: "participant.join", value: { entity: ines } })
      yield* addState(null, { key: "played_by_me.set", value: { entities: [me, tomas] } })
      // A preset bound for Tomas: an event scoped to him.
      const style = (yield* entity("Style", "preset")).ref.id
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        slotId: null,
        versionId: null,
        scope: tomas,
        data: { key: "preset.binding", value: { ref: style } }
      })
      assert.deepStrictEqual(Object.keys((yield* stateAt(null)).presetBindings), [tomas])
      const turn = yield* append(chat.activeLeafSlotId!, say(me, "Tomas heads home."))
      yield* addState(turn.slotId, { key: "participant.leave", value: { entity: tomas } })
      const reply = yield* append(turn.slotId, generated(mira, "Mira waves."))

      // In the bin, Ines can be taken out of the chat, but not brought in.
      yield* writer.DeleteEntity({ userId, entityId: ines })
      yield* addState(reply.slotId, { key: "participant.leave", value: { entity: ines } })
      const join = yield* addState(reply.slotId, { key: "participant.join", value: { entity: ines } }).pipe(Effect.flip)
      assert.strictEqual(join._tag, "NotFound")

      // Tomas is deleted for good. Deleting the message where he left doesn't bring him
      // back, and neither does restoring it.
      const item = yield* writer.DeleteEntity({ userId, entityId: tomas })
      yield* writer.PurgeBinItem({ userId, itemId: item.id })
      yield* addState(reply.slotId, { key: "participant.leave", value: { entity: tomas } })
      const message = yield* writer.DeleteMessage({ userId, slotId: turn.slotId })
      const state = yield* stateAt(reply.slotId)
      assert.deepStrictEqual([state.participants, state.playedByMe], [[mira, me], [me]])
      assert.deepStrictEqual(state.presetBindings, {})
      yield* writer.RestoreBinItem({ userId, itemId: message.id })
      assert.deepStrictEqual((yield* stateAt(reply.slotId)).participants, [mira, me])
    }).pipe(Effect.provide(database()))
  )
})

describe("window reads", () => {
  // A window must stop walking at its limit, not walk the whole path and keep the newest slots.
  it.live(
    "stop at their limit even with a cycle further up, and walk the path by index",
    () => {
      const dataDir = tempDir("graph")
      return Effect.gen(function* () {
        const { userId, chatId, slots } = yield* Effect.gen(function* () {
          const { userId, me, mira, chat, append } = yield* setup()
          let leaf = chat.activeLeafSlotId!
          const slots: Array<SlotId> = [leaf]
          for (let i = 0; i < 300; i++) {
            leaf = (yield* append(leaf, i % 2 === 0 ? say(me, `line ${i}`) : generated(mira, `reply ${i}`))).slotId
            slots.push(leaf)
          }
          return { userId, chatId: chat.id, slots }
        }).pipe(Effect.provide(database(dataDir)))

        // A cycle among slots older than the window: depth 10's parent becomes depth 100.
        // Only a walk past its limit reaches it, and then never ends. The schema forbids
        // this, so its trigger goes first.
        const raw = new DatabaseSync(databaseFile(dataDir))
        raw.exec("DROP TRIGGER slots_shape_fixed")
        raw.prepare("UPDATE slots SET parent_slot_id = ? WHERE id = ?").run(slots[100]!, slots[10]!)
        raw.close()
        // In a child process: an endless walk can't be stopped any other way.
        assert.strictEqual(yield* probeWindow(dataDir, userId, chatId, "50"), "50")

        // Each step of the walk is an index lookup: only the walk itself is scanned.
        const plan = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const [text, params] = pathWindow(sql, chatId, slots.at(-1)!, 200).compile()
          const rows = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params)
          return rows.map((row) => row.detail)
        }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })))
        assert.deepStrictEqual(
          plan.filter((step) => step.startsWith("SCAN")),
          ["SCAN p", "SCAN path"],
          plan.join("\n")
        )
        assert.include(plan, "SEARCH s USING INDEX sqlite_autoindex_slots_1 (id=?)", plan.join("\n"))
      })
    },
    60_000
  )
})
