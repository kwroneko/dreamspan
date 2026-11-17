import { canonicalJson } from "@rp/shared/editing.ts"
import { assert, layer } from "@effect/vitest"
import { NewVersion, type EntityId, type ForkId, type SlotId } from "@rp/shared/chat.ts"
import { newCardNote, newChatNote } from "@rp/shared/editing.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = (yield* api.Whoami()).id
  const card = yield* writer.CreateEntity({
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
    title: "Notes on a fork",
    participants: [card.ref.entityId],
    greeting: null
  })
  const main = chat.currentForkId as ForkId
  const append = (parentSlotId: SlotId | null, content: string) =>
    writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId: main,
      parentSlotId,
      branch: false,
      commitDraft: null,
      version: new NewVersion({
        speakerEntityId: null,
        writer: "human",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      })
    })
  const a = yield* append(null, "They reach the old harbour.")
  const b = yield* append(a.slotId, "The treaty is signed.")
  const bind = (note: EntityId, revision: string, slotId: SlotId) =>
    writer.AddStateEvent({
      userId,
      chatId: chat.id,
      forkId: main,
      slotId,
      versionId: null,
      scope: null,
      data: { key: "note.binding", value: { note, revision: revision as never } }
    })
  const toggle = (note: EntityId, enabled: boolean, slotId: SlotId) =>
    writer.AddStateEvent({
      userId,
      chatId: chat.id,
      forkId: main,
      slotId,
      versionId: null,
      scope: null,
      data: { key: enabled ? "note.activate" : "note.deactivate", value: { note } }
    })
  const note = yield* writer.CreateEntity({
    userId,
    kind: "note",
    label: "Treaty",
    subtitle: "",
    doc: { ...newChatNote(chat.id, "Treaty"), content: "The cities are at war." },
    schemaVersion: 1,
    origin: "user",
    sourcePath: null
  })
  yield* bind(note.ref.entityId, note.ref.headRevisionId, a.slotId)
  yield* toggle(note.ref.entityId, true, a.slotId)
  const changed = yield* writer.EditRef({
    userId,
    refId: note.ref.id,
    expectedRowVersion: note.ref.rowVersion,
    doc: { ...newChatNote(chat.id, "Treaty"), content: "The cities are now at peace." },
    message: null,
    commitDraft: null
  })
  yield* bind(note.ref.entityId, changed.ref.headRevisionId, b.slotId)
  yield* toggle(note.ref.entityId, false, b.slotId)
  const cardNote = yield* writer.CreateEntity({
    userId,
    kind: "note",
    label: "Costume",
    subtitle: "",
    doc: { ...newCardNote(card.ref.entityId, "Costume"), content: "Mira wears a blue coat.", on_by_default: true },
    schemaVersion: 1,
    origin: "user",
    sourcePath: null
  })
  yield* toggle(cardNote.ref.entityId, false, b.slotId)
  const payload = { userId, chatId: chat.id, fromForkId: main, atSlotId: a.slotId }
  const preview = yield* reader.PreviewForkNotes(payload)
  const state = (forkId: ForkId, slotId: SlotId = a.slotId) =>
    Effect.map(reader.StateEventsAt({ userId, chatId: chat.id, forkId, slotId }), foldState)
  return {
    api,
    writer,
    reader,
    userId,
    chat,
    main,
    a,
    b,
    note: note.ref,
    cardNote: cardNote.ref,
    changed: changed.ref,
    card: card.ref,
    payload,
    preview,
    state,
    toggle
  }
})

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "120 seconds" })(
  "fork note inheritance",
  (it) => {
    for (const membership of ["earlier cast", "played card"] as const)
      it.effect(`offers activation choices for a card in the ${membership}`, () =>
        Effect.gen(function* () {
          const h = yield* setup
          if (membership === "played card")
            yield* h.writer.AddStateEvent({
              userId: h.userId,
              chatId: h.chat.id,
              forkId: h.main,
              slotId: h.a.slotId,
              versionId: null,
              scope: null,
              data: { key: "played_by_me.set", value: { entities: [h.card.entityId] } }
            })
          yield* h.writer.AddStateEvent({
            userId: h.userId,
            chatId: h.chat.id,
            forkId: h.main,
            slotId: membership === "played card" ? h.a.slotId : h.b.slotId,
            versionId: null,
            scope: null,
            data: { key: "participant.leave", value: { entity: h.card.entityId } }
          })
          const preview = yield* h.reader.PreviewForkNotes(h.payload)
          const note = preview.notes.find((row) => row.note === h.cardNote.entityId)
          assert.isDefined(note)
          assert.isTrue(note!.then.enabled)
          assert.isFalse(note!.now.enabled)
          const made = yield* h.writer.CreateFork({
            ...h.payload,
            notes: {
              comparison: canonicalJson(preview),
              choices: [{ note: h.cardNote.entityId, choice: "now" }]
            }
          })
          const notes = yield* h.api.ListChatNotes({ chatId: h.chat.id, forkId: made.fork.id, slotId: h.a.slotId })
          assert.isFalse(notes.find((row) => row.ref.entityId === h.cardNote.entityId)!.active)
        })
      )

    it.effect("carrying a changed switch keeps an unchanged binding attached to its version", () =>
      Effect.gen(function* () {
        const h = yield* setup
        yield* h.writer.AddStateEvent({
          userId: h.userId,
          chatId: h.chat.id,
          forkId: h.main,
          slotId: h.a.slotId,
          versionId: h.a.version.id,
          scope: null,
          data: { key: "note.binding", value: { note: h.note.entityId, revision: h.changed.headRevisionId } }
        })
        const preview = yield* h.reader.PreviewForkNotes(h.payload)
        const made = yield* h.writer.CreateFork({
          ...h.payload,
          notes: {
            comparison: canonicalJson(preview),
            choices: [{ note: h.note.entityId, choice: "now" }]
          }
        })
        assert.strictEqual((yield* h.state(made.fork.id)).noteRevisions[h.note.entityId], h.changed.headRevisionId)
        yield* h.writer.AddVersion({
          userId: h.userId,
          slotId: h.a.slotId,
          forkId: made.fork.id,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content: "Another arrival.",
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          }),
          select: true,
          commitDraft: null
        })
        assert.strictEqual((yield* h.state(made.fork.id)).noteRevisions[h.note.entityId], h.note.headRevisionId)
        assert.notInclude((yield* h.state(made.fork.id)).activeNotes, h.note.entityId)
      })
    )

    for (const choice of ["then", "now"] as const)
      it.effect(
        `${choice} choices preserve unchanged version-attached switches when the inherited message is swiped`,
        () =>
          Effect.gen(function* () {
            const h = yield* setup
            yield* h.writer.AddStateEvent({
              userId: h.userId,
              chatId: h.chat.id,
              forkId: h.main,
              slotId: h.a.slotId,
              versionId: h.a.version.id,
              scope: null,
              data: { key: "note.deactivate", value: { note: h.note.entityId } }
            })
            const preview = yield* h.reader.PreviewForkNotes(h.payload)
            const made = yield* h.writer.CreateFork({
              ...h.payload,
              notes: { comparison: canonicalJson(preview), choices: [{ note: h.note.entityId, choice }] }
            })
            assert.notInclude((yield* h.state(made.fork.id)).activeNotes, h.note.entityId)
            yield* h.writer.AddVersion({
              userId: h.userId,
              slotId: h.a.slotId,
              forkId: made.fork.id,
              version: new NewVersion({
                speakerEntityId: null,
                writer: "human",
                content: "Another arrival.",
                status: "complete",
                macroMode: "verbatim",
                origin: "user_written"
              }),
              select: true,
              commitDraft: null
            })
            assert.include((yield* h.state(made.fork.id)).activeNotes, h.note.entityId)
          })
      )

    it.effect("previews text and switches; mixed choices persist independently and later forks inherit them", () =>
      Effect.gen(function* () {
        const h = yield* setup
        assert.strictEqual(h.preview.notes.length, 2)
        const note = h.preview.notes.find((row) => row.note === h.note.entityId)!
        assert.strictEqual(note.then.content, "The cities are at war.")
        assert.strictEqual(note.now.content, "The cities are now at peace.")
        assert.isTrue(note.then.enabled)
        assert.isFalse(note.now.enabled)
        const made = yield* h.api.CreateFork({
          ...h.payload,
          notes: {
            comparison: canonicalJson(h.preview),
            choices: [
              { note: h.note.entityId, choice: "now" },
              { note: h.cardNote.entityId, choice: "then" }
            ]
          }
        })
        const state = yield* h.state(made.fork.id)
        assert.strictEqual(state.noteRevisions[h.note.entityId], h.changed.headRevisionId)
        assert.notInclude(state.activeNotes, h.note.entityId)
        const notes = yield* h.api.ListChatNotes({ chatId: h.chat.id, forkId: made.fork.id, slotId: h.a.slotId })
        assert.isTrue(notes.find((row) => row.ref.entityId === h.cardNote.entityId)!.active)
        // Card-note choices change activation only; card text keeps its library ownership.
        assert.isUndefined(state.noteRevisions[h.cardNote.entityId])
        const parent = yield* h.state(h.main, h.b.slotId)
        assert.notInclude(parent.activeNotes, h.cardNote.entityId)
        const later = yield* h.writer.CreateFork({ ...h.payload, fromForkId: made.fork.id })
        assert.strictEqual((yield* h.state(later.fork.id)).noteRevisions[h.note.entityId], h.changed.headRevisionId)
        yield* h.toggle(h.note.entityId, true, h.b.slotId)
        assert.notInclude((yield* h.state(made.fork.id)).activeNotes, h.note.entityId)
      })
    )

    it.effect("defaults every note to then, including omitted choices and the legacy API", () =>
      Effect.gen(function* () {
        const h = yield* setup
        for (const notes of [undefined, { comparison: canonicalJson(h.preview), choices: [] }]) {
          const made = yield* h.writer.CreateFork({ ...h.payload, ...(notes ? { notes } : {}) })
          const state = yield* h.state(made.fork.id)
          assert.strictEqual(state.noteRevisions[h.note.entityId], h.note.headRevisionId)
          assert.include(state.activeNotes, h.note.entityId)
          // Default-on card notes require no explicit activate event with the legacy API.
          const comparison = yield* h.reader.PreviewForkNotes({ ...h.payload, fromForkId: made.fork.id })
          assert.strictEqual(comparison.notes.length, 0)
        }
      })
    )

    it.effect("rejects stale comparisons atomically and rejects unknown note selections", () =>
      Effect.gen(function* () {
        const h = yield* setup
        const before = (yield* h.api.ListForks({ chatId: h.chat.id })).length
        yield* h.toggle(h.note.entityId, true, h.b.slotId)
        assert.strictEqual(
          yield* outcome(
            h.api.CreateFork({ ...h.payload, notes: { comparison: canonicalJson(h.preview), choices: [] } })
          ),
          "ForkNotesChanged"
        )
        const fresh = yield* h.reader.PreviewForkNotes(h.payload)
        assert.strictEqual(
          yield* outcome(
            h.writer.CreateFork({
              ...h.payload,
              notes: {
                comparison: canonicalJson(fresh),
                choices: [{ note: "00000000-0000-7000-8000-000000000000" as EntityId, choice: "now" }]
              }
            })
          ),
          "ForkNotesChanged"
        )
        assert.strictEqual((yield* h.api.ListForks({ chatId: h.chat.id })).length, before)
        assert.strictEqual((yield* h.api.GetChat({ chatId: h.chat.id })).currentForkId, h.main)
      })
    )

    it.effect("all-now choices carry text and card activation; version-attached effects stay causal", () =>
      Effect.gen(function* () {
        const h = yield* setup
        yield* h.writer.AddStateEvent({
          userId: h.userId,
          chatId: h.chat.id,
          forkId: h.main,
          slotId: h.b.slotId,
          versionId: h.b.version.id,
          scope: null,
          data: { key: "note.activate", value: { note: h.note.entityId } }
        })
        const preview = yield* h.reader.PreviewForkNotes(h.payload)
        assert.isFalse(preview.notes.find((row) => row.note === h.note.entityId)!.now.enabled)
        const made = yield* h.writer.CreateFork({
          ...h.payload,
          notes: {
            comparison: canonicalJson(preview),
            choices: preview.notes.map((row) => ({ note: row.note, choice: "now" as const }))
          }
        })
        const state = yield* h.state(made.fork.id)
        assert.strictEqual(state.noteRevisions[h.note.entityId], h.changed.headRevisionId)
        assert.notInclude(state.activeNotes, h.note.entityId)
        assert.notInclude(state.activeNotes, h.cardNote.entityId)
        assert.include((yield* h.state(h.main, h.b.slotId)).activeNotes, h.note.entityId)
      })
    )

    it.effect("checks source-fork and fork-point membership before exposing notes", () =>
      Effect.gen(function* () {
        const h = yield* setup
        const empty = yield* h.writer.CreateFork({ ...h.payload, atSlotId: null })
        assert.strictEqual(
          yield* outcome(h.reader.PreviewForkNotes({ ...h.payload, fromForkId: empty.fork.id })),
          "NotFound"
        )
        assert.strictEqual(
          yield* outcome(
            h.api.PreviewForkNotes({ ...h.payload, fromForkId: "00000000-0000-7000-8000-000000000000" as ForkId })
          ),
          "NotFound"
        )
      })
    )
  }
)
