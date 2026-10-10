// Drafts with server-persisted undo history (DESIGN §6.2), through the real workers.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"

const database = () =>
  Database.layer({
    dataDir: mkdtempSync(join(tmpdir(), "rp-drafts-")),
    readers: 2,
    allowNetworkFs: false,
    workers: "source"
  })

const setup = (handle = "ana") =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const user = yield* writer.EnsureUser({ handle, displayName: handle })
    const userId = user.id
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "",
      participants: [],
      greeting: null
    })
    const composer = new DraftKey({ targetKind: "composer", targetId: chat.id, field: "" })
    let rowVersion: number | null = null
    /** Saves like a client does: passing the row version it last saw. */
    const type = (content: string) =>
      writer
        .SaveDraft({ userId, key: composer, content, expectedRowVersion: rowVersion, baseRevision: null })
        .pipe(Effect.tap((draft) => Effect.sync(() => (rowVersion = draft.rowVersion))))
    const history = () => reader.DraftHistory({ userId, key: composer, limit: 1000 })
    /** Takes the row version from a draft a write returned, as a client would. */
    const sync = (draft: { readonly rowVersion: number } | null) => {
      if (draft) rowVersion = draft.rowVersion
    }
    return { writer, reader, userId, chat, composer, type, history, sync, rowVersion: () => rowVersion! }
  })

describe("drafts", () => {
  it.live("the first save creates the draft; later saves from a stale tab are refused", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, composer, type } = yield* setup()
      const first = yield* type("Hel")
      assert.strictEqual(first.status, "active")
      yield* type("Hello")

      const stale = yield* writer
        .SaveDraft({
          userId,
          key: composer,
          content: "Hello from tab B",
          expectedRowVersion: first.rowVersion,
          baseRevision: null
        })
        .pipe(Effect.flip)
      assert.strictEqual(stale._tag, "StaleWrite")
      assert.strictEqual((yield* reader.GetDraft({ userId, key: composer }))!.content, "Hello")
    }).pipe(Effect.provide(database()))
  )

  it.live("typing coalesces into one entry, and a select-all wipe stays restorable (DESIGN §6.2)", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, composer, type, history, rowVersion } = yield* setup()
      const paragraph = "She hesitated at the door, then knocked twice, listening for footsteps."
      // Debounced saves while typing.
      for (let i = 10; i <= paragraph.length; i += 10) yield* type(paragraph.slice(0, i))
      yield* type(paragraph)
      assert.strictEqual((yield* history()).filter((s) => s.kind === "edit").length, 1)

      // Ctrl-A and a stray key.
      yield* type("x")
      const states = yield* history()
      assert.deepStrictEqual(
        states.map((s) => [s.kind, s.length]),
        [
          ["edit", 1],
          ["edit", paragraph.length],
          ["initial", 10]
        ]
      )

      // The paragraph is one step back, and restoring it is itself undoable.
      const before = states[1]!
      assert.strictEqual((yield* reader.GetDraftState({ userId, key: composer, seq: before.seq })).content, paragraph)
      const restored = yield* writer.RestoreDraftState({
        userId,
        key: composer,
        seq: before.seq,
        expectedRowVersion: rowVersion()
      })
      assert.strictEqual(restored.content, paragraph)
      const after = yield* history()
      assert.strictEqual(after[0]!.kind, "restore")
      assert.strictEqual((yield* reader.GetDraftState({ userId, key: composer, seq: after[1]!.seq })).content, "x")
    }).pipe(Effect.provide(database()))
  )

  it.live("sending a message commits its draft in the same transaction", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, composer, type, sync } = yield* setup()
      const me = yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Me",
        subtitle: "",
        doc: { name: "Me" },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const say = (content: string) =>
        new NewVersion({
          speakerEntityId: me.entityId,
          writer: "human",
          content,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })

      const saved = yield* type("Who rang the bell?")
      const sent = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId: null,
        version: say(saved.content),
        commitDraft: { key: composer, expectedRowVersion: saved.rowVersion }
      })
      // The committed text lives in the message now: the draft is emptied and its
      // history deleted. Nothing destructive happened, so there's nothing to recover.
      assert.strictEqual(sent.draft?.status, "committed")
      assert.strictEqual(sent.draft?.content, "")
      assert.strictEqual(sent.draft?.historyLength, 0)
      assert.isNull(sent.draft?.recovery)
      sync(sent.draft)
      assert.deepStrictEqual(yield* reader.ListActiveDrafts({ userId }), [])

      // Typing again starts a new session with a fresh history.
      const reopened = yield* type("And then?")
      assert.strictEqual(reopened.status, "active")
      assert.strictEqual(reopened.historyLength, 1)

      // Another tab kept typing after this one sent: the newer text stays as a draft.
      const sentFrom = reopened.rowVersion
      yield* type("And then? Tell me more.")
      const second = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId: sent.slotId,
        version: say("And then?"),
        commitDraft: { key: composer, expectedRowVersion: sentFrom }
      })
      assert.strictEqual(second.draft?.status, "active")
      assert.strictEqual(second.draft?.content, "And then? Tell me more.")
    }).pipe(Effect.provide(database()))
  )

  it.live("a wipe followed by a send leaves the wiped text recoverable, until the next commit", () =>
    Effect.gen(function* () {
      const { writer, userId, chat, composer, type, sync } = yield* setup()
      const me = yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Me",
        subtitle: "",
        doc: { name: "Me" },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const send = (content: string, rowVersion: number, parentSlotId: SlotId | null) =>
        writer.AppendMessage({
          userId,
          chatId: chat.id,
          parentSlotId,
          version: new NewVersion({
            speakerEntityId: me.entityId,
            writer: "human",
            content,
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          }),
          commitDraft: { key: composer, expectedRowVersion: rowVersion }
        })

      const long = "A long reply the user spent a while on, about the lighthouse and the storm."
      yield* type(long)
      const wiped = yield* type("x") // select-all plus a stray key...
      const first = yield* send("x", wiped.rowVersion, null) // ...then Enter
      assert.strictEqual(first.draft?.recovery?.content, long)
      assert.strictEqual(first.draft?.historyLength, 0)
      sync(first.draft)

      // An ordinary next message replaces the recovery.
      const next = yield* type("Sorry, that was a slip.")
      const second = yield* send(next.content, next.rowVersion, first.slotId)
      assert.isNull(second.draft?.recovery)
    }).pipe(Effect.provide(database()))
  )

  it.live("discarding keeps the discarded text as the recovery", () =>
    Effect.gen(function* () {
      const { writer, userId, composer, type } = yield* setup()
      const draft = yield* type("Second thoughts.")
      const discarded = yield* writer.ClearDraft({
        userId,
        key: composer,
        outcome: "discarded",
        expectedRowVersion: draft.rowVersion
      })
      assert.strictEqual(discarded.content, "")
      assert.strictEqual(discarded.recovery?.content, "Second thoughts.")
    }).pipe(Effect.provide(database()))
  )

  it.live("drafts belong to their user, on targets that user owns, within a size limit", () =>
    Effect.gen(function* () {
      const ana = yield* setup("ana")
      const bob = yield* setup("bob")
      yield* ana.type("private")
      assert.isNull(yield* bob.reader.GetDraft({ userId: bob.userId, key: ana.composer }))
      const foreign = yield* bob.writer
        .SaveDraft({
          userId: bob.userId,
          key: ana.composer,
          content: "hi",
          expectedRowVersion: null,
          baseRevision: null
        })
        .pipe(Effect.flip)
      assert.strictEqual(foreign._tag, "NotFound")

      const huge = yield* bob.writer
        .SaveDraft({
          userId: bob.userId,
          key: bob.composer,
          content: "x".repeat(1_000_001),
          expectedRowVersion: null,
          baseRevision: null
        })
        .pipe(Effect.flip)
      assert.strictEqual(huge._tag, "DraftTooLarge")
    }).pipe(Effect.provide(database()))
  )

  it.live(
    "keeps a bounded history",
    () =>
      Effect.gen(function* () {
        const { type, history } = yield* setup()
        // Alternating wipes never coalesce, so each save is its own entry.
        for (let i = 0; i < 1010; i++)
          yield* type(i % 2 === 0 ? `A long sentence that keeps getting replaced, take ${i}.` : "x")
        const states = yield* history()
        assert.strictEqual(states.filter((s) => s.kind !== "initial").length, 1000)
      }).pipe(Effect.provide(database())),
    60_000
  )
})
