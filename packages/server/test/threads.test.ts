// Starting parallel threads (spec/THREADS.md §5, TH2) through the real server: Mira, Wren and the
// user's Tobin in a chat set to separate contexts. Threads start at Mira's reply S, an earlier
// message: the messages after it (a swipe chosen on one, a merged branch's join) stay the first
// thread's, with Wren, moved to the other thread, not there for them in this branch only, never
// in a sibling made before. Fork independence, the away marks, the composers, rename, Undo and
// restore through the bin, refusals and another user's probes. Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { textField } from "@rp/shared/editing.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const mockProvider = Effect.acquireRelease(
  Effect.promise(() =>
    startMockProvider((_request, res) =>
      sse(res, completionChunks(["The ledger says otherwise."], { prompt_tokens: 10, completion_tokens: 4 }))
    )
  ),
  (m) => Effect.promise(() => m.close())
)

const sentText = (snapshot: ContextSnapshot) =>
  snapshot.request.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as ReadonlyArray<{ text?: string }>).map((p) => p.text ?? "").join("")
    )
    .join("\n")

const story = (setting: "separate" | null) =>
  Effect.gen(function* () {
    const mock = yield* mockProvider
    const api = yield* client()
    const reader = yield* Reader
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const made = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      characters: ["Wren"],
      state: setting ? [{ key: "context.per_speaker", value: setting }] : []
    })
    const chatId = made.chat.id
    const mira = made.mira.entityId as EntityId
    const wren = made.characters[0]!.entityId as EntityId
    const user = made.sent.version.speakerEntityId as EntityId
    const F = made.chat.currentForkId! as ForkId
    const S = made.version.slotId as SlotId
    const tobin = foldState(yield* reader.StateEventsAt({ userId, chatId, slotId: S, forkId: F }))
      .playedByMe[0] as EntityId
    const append = (fork: ForkId, parent: SlotId, speaker: EntityId | null, content: string, model = false) =>
      writer.AppendMessage({
        userId,
        chatId,
        forkId: fork,
        parentSlotId: parent,
        branch: true,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: speaker,
          writer: model ? "model" : "human",
          content,
          status: "complete",
          macroMode: "verbatim",
          origin: model ? "generated" : "user_written"
        })
      })
    /** The context of a reply by `speaker` at `parent` in `fork`: its own placeholder row (a branch there). */
    const contextFor = (fork: ForkId, parent: SlotId, speaker: EntityId) =>
      Effect.gen(function* () {
        const row = yield* writer.AppendMessage({
          userId,
          chatId,
          forkId: fork,
          parentSlotId: parent,
          branch: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: speaker,
            writer: "model",
            content: "",
            status: "generating",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        const built = yield* reader.AssembleContext({
          userId,
          chatId,
          slotId: row.slotId,
          versionId: row.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null,
          forkId: row.forkId
        })
        return sentText(JSON.parse(built.snapshot) as ContextSnapshot)
      })
    const rowVersion = (slotId: SlotId, forkId: ForkId) =>
      Effect.map(reader.GetSlot({ userId, slotId, forkId }), (slot) => slot.entry.rowVersion)
    return { api, reader, writer, userId, chatId, mira, wren, tobin, user, F, S, made, append, contextFor, rowVersion }
  })

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))

describe("starting parallel threads", () => {
  it.live(
    "at an earlier message: the played messages stay the first thread's, the moved character not there for them here only",
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* story("separate")
          const { api, F, S } = t
          const before = t.made.sent.slotId as SlotId
          // A branch made before S, with a message Wren was there for: merged into F later.
          const { fork: docks } = yield* api.CreateFork({ chatId: t.chatId, fromForkId: F, atSlotId: before })
          yield* t.append(docks.id, before, t.user, "Wren finds the boat.")
          // A swipe on S, chosen in F.
          const swipeS = yield* t.writer.AddSelectedVersion({
            userId: t.userId,
            slotId: S,
            forkId: F,
            expectedRowVersion: yield* t.rowVersion(S, F),
            version: new NewVersion({
              speakerEntityId: t.mira,
              writer: "model",
              content: "Mira shrugs at the rain.",
              status: "complete",
              macroMode: "verbatim",
              origin: "generated"
            })
          })
          assert.strictEqual(swipeS.version.content, "Mira shrugs at the rain.")
          // The played stretch: two messages, a swipe chosen on the second, the docks merged in.
          const code = yield* t.append(F, S, t.user, "The vault code is 739.")
          const key = yield* t.append(F, code.slotId, t.mira, "Mira hides the key under the stair.", true)
          yield* t.writer.AddSelectedVersion({
            userId: t.userId,
            slotId: key.slotId,
            forkId: F,
            expectedRowVersion: yield* t.rowVersion(key.slotId, F),
            version: new NewVersion({
              speakerEntityId: t.mira,
              writer: "model",
              content: "Mira drops the key in the well.",
              status: "complete",
              macroMode: "verbatim",
              origin: "generated"
            })
          })
          const seen = yield* t.reader.PreviewChatMerge({
            userId: t.userId,
            chatId: t.chatId,
            forkId: F,
            at: null,
            source: { chatId: t.chatId, forkId: docks.id },
            includeLeftOut: false
          })
          const joined = yield* t.writer.MergeChat({
            userId: t.userId,
            chatId: t.chatId,
            forkId: F,
            at: null,
            source: { chatId: t.chatId, forkId: docks.id },
            includeLeftOut: false,
            title: seen.sourceTitle,
            framing: null,
            digest: seen.digest
          })
          const tip = joined.slotId as SlotId
          // A sibling at the same tip, made before the threads.
          const { fork: peer } = yield* api.CreateFork({ chatId: t.chatId, fromForkId: F, atSlotId: tip })
          const wrenBefore = yield* t.contextFor(peer.id, tip, t.wren)
          assert.include(wrenBefore, "vault code")
          assert.include(wrenBefore, "finds the boat")

          const started = yield* api.StartThreads({
            chatId: t.chatId,
            forkId: F,
            slotId: S,
            expectedRowVersion: yield* t.rowVersion(S, F),
            threads: [
              { name: "At the Lantern", cast: [t.mira, t.tobin], writesAs: t.tobin },
              { name: "At the docks", cast: [t.wren, t.tobin], writesAs: t.wren }
            ]
          })
          assert.strictEqual(started.forkIds[0], F)
          assert.strictEqual(started.forkIds.length, 2)
          const wrenThread = started.forkIds[1]!
          assert.notStrictEqual(started.chat.currentForkId, wrenThread, "the user stays where they were")

          // Which thread each fork is in: F and its thread, never the branches made before.
          const forks = yield* api.ListForks({ chatId: t.chatId })
          const placesOf = (id: string) => forks.find((f) => f.id === id)?.threads
          assert.deepStrictEqual(placesOf(F), [{ splitId: started.splitId, ordinal: 0 }])
          assert.deepStrictEqual(placesOf(wrenThread), [{ splitId: started.splitId, ordinal: 1 }])
          assert.isUndefined(placesOf(peer.id))
          assert.isUndefined(placesOf(docks.id))
          const [set] = yield* api.ThreadsOf({ chatId: t.chatId, forkId: F })
          assert.strictEqual(set!.self, 0)
          assert.strictEqual(set!.slotId, S)
          assert.deepStrictEqual(
            set!.threads.map((thread) => [thread.name, thread.openForkId, thread.starts]),
            [
              ["At the Lantern", F, false],
              ["At the docks", wrenThread, true]
            ]
          )
          assert.deepStrictEqual(yield* api.ThreadsOf({ chatId: t.chatId, forkId: peer.id }), [])

          // The away marks: each thread's own, at S; the sibling unchanged.
          assert.deepStrictEqual((yield* api.GetCast({ chatId: t.chatId, forkId: F, slotId: tip })).away, [t.wren])
          assert.deepStrictEqual((yield* api.GetCast({ chatId: t.chatId, forkId: wrenThread, slotId: S })).away, [
            t.mira
          ])
          assert.notProperty(yield* api.GetCast({ chatId: t.chatId, forkId: peer.id, slotId: tip }), "away")
          // The new thread starts at S, showing S as F did (its swipe).
          const opened = yield* t.reader.GetSlot({ userId: t.userId, slotId: S, forkId: wrenThread })
          assert.strictEqual(opened.entry.version.content, "Mira shrugs at the rain.")

          // Each thread's composer writes as its card; the new one starts empty.
          const composer = yield* api.OpenComposer({ chatId: t.chatId, forkId: wrenThread })
          assert.strictEqual(composer.content, "")
          assert.strictEqual(
            (yield* api.GetComposerChoice({ chatId: t.chatId, draftId: composer.id })).speakerEntityId,
            t.wren
          )
          const own = yield* api.OpenComposer({ chatId: t.chatId, forkId: F })
          assert.strictEqual(
            (yield* api.GetComposerChoice({ chatId: t.chatId, draftId: own.id })).speakerEntityId,
            t.tobin
          )

          // Wren wasn't there for the played stretch in F, nor in a branch made from it now; she
          // still was in the sibling made before; Mira was, and Wren knows her own past.
          const wrenHere = yield* t.contextFor(F, tip, t.wren)
          assert.include(wrenHere, "The road flooded.")
          for (const missed of ["vault code", "in the well", "finds the boat"]) assert.notInclude(wrenHere, missed)
          const wrenPeer = yield* t.contextFor(peer.id, tip, t.wren)
          assert.include(wrenPeer, "vault code")
          assert.include(wrenPeer, "finds the boat")
          const miraHere = yield* t.contextFor(F, tip, t.mira)
          assert.include(miraHere, "vault code")
          assert.include(miraHere, "in the well")
          // The agent's reads agree: in F, Wren is away for the message and the join; not in the sibling.
          const join = yield* t.reader.GetSlot({ userId: t.userId, slotId: tip, forkId: F })
          const knowers = (forkId: ForkId) =>
            t.reader.KnowersOf({
              userId: t.userId,
              chatId: t.chatId,
              forkId,
              versionIds: [code.version.id, join.entry.version.id],
              viewers: [t.wren]
            })
          assert.deepStrictEqual(
            (yield* knowers(F)).map((k) => k.away),
            [[t.wren], [t.wren]]
          )
          assert.deepStrictEqual(
            (yield* knowers(peer.id)).map((k) => k.away),
            [undefined, undefined]
          )

          // Rename: in all the thread's branches; a stale tab is refused.
          const renamed = yield* api.RenameThread({
            chatId: t.chatId,
            splitId: started.splitId,
            ordinal: 1,
            name: "  Down at   the docks ",
            rowVersion: set!.threads[1]!.rowVersion
          })
          assert.strictEqual(
            yield* outcome(
              api.RenameThread({
                chatId: t.chatId,
                splitId: started.splitId,
                ordinal: 1,
                name: "Again",
                rowVersion: set!.threads[1]!.rowVersion
              })
            ),
            "StaleWrite"
          )
          const [after] = yield* api.ThreadsOf({ chatId: t.chatId, forkId: wrenThread })
          assert.strictEqual(after!.self, 1)
          assert.strictEqual(after!.threads[1]!.name, "Down at the docks")
          assert.strictEqual(after!.threads[1]!.rowVersion, renamed)

          // Undo: the new thread goes to the bin; F is as before (Wren back, the stretch hers).
          const item = yield* api.UndoThreads({ chatId: t.chatId, splitId: started.splitId })
          assert.strictEqual(item.kind, "threads")
          const undone = yield* api.ListForks({ chatId: t.chatId })
          assert.isUndefined(undone.find((f) => f.id === wrenThread))
          assert.isUndefined(undone.find((f) => f.id === F)?.threads, "a split with one live thread shows nowhere")
          assert.notProperty(yield* api.GetCast({ chatId: t.chatId, forkId: F, slotId: tip }), "away")
          const wrenUndone = yield* t.contextFor(F, tip, t.wren)
          assert.include(wrenUndone, "vault code")
          assert.include(wrenUndone, "finds the boat")
          assert.strictEqual(
            yield* outcome(api.UndoThreads({ chatId: t.chatId, splitId: started.splitId })),
            "NotFound"
          )

          // Restore: as started.
          yield* api.RestoreBinItem({ itemId: item.id })
          const restored = yield* api.ListForks({ chatId: t.chatId })
          assert.deepStrictEqual(restored.find((f) => f.id === wrenThread)?.threads, [
            { splitId: started.splitId, ordinal: 1 }
          ])
          assert.deepStrictEqual((yield* api.GetCast({ chatId: t.chatId, forkId: F, slotId: tip })).away, [t.wren])
          const wrenRestored = yield* t.contextFor(F, tip, t.wren)
          assert.notInclude(wrenRestored, "vault code")
          assert.notInclude(wrenRestored, "finds the boat")
        })
      )
  )

  it.live(
    "the client's reads: each thread's characters, the left panel's Threads list, and a note copied to a thread",
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* story(null)
          const { api, F, S } = t
          // A branch from before, so the chat has a branch apart from the threads.
          const { fork: aside } = yield* api.CreateFork({
            chatId: t.chatId,
            fromForkId: F,
            atSlotId: t.made.sent.slotId
          })
          const note = yield* api.CreateChatNote({ chatId: t.chatId, forkId: F, title: "Weather" })
          const started = yield* api.StartThreads({
            chatId: t.chatId,
            forkId: F,
            slotId: S,
            expectedRowVersion: yield* t.rowVersion(S, F),
            threads: [
              { name: null, cast: [t.mira, t.tobin], writesAs: t.tobin },
              { name: null, cast: [t.wren], writesAs: null }
            ]
          })
          const docks = started.forkIds[1]!
          const [set] = yield* api.ThreadsOf({ chatId: t.chatId, forkId: F })
          assert.deepStrictEqual(
            set!.threads.map((thread) => thread.cast),
            [[t.mira], [t.wren]]
          )

          // The panel lists both threads under Threads, the earlier branch under Branches; the
          // chat's branch count leaves the new thread out.
          const view = {
            entity: null,
            chat: t.chatId,
            search: "",
            sort: "recent" as const,
            sections: [
              { id: "threads" as const, limit: 100 },
              { id: "pinnedBranches" as const, limit: 100 },
              { id: "peers" as const, limit: 100 },
              { id: "other" as const, limit: 100 }
            ]
          }
          const shell = yield* api.GetShellForks(view)
          const rows = (id: string) => shell.sections.find((s) => s.id === id)!.rows
          assert.sameMembers(
            rows("threads").map((f) => f.forkId),
            [F, docks]
          )
          assert.deepStrictEqual(rows("threads").find((f) => f.forkId === docks)?.threads, [
            { splitId: started.splitId, ordinal: 1 }
          ])
          // Each row says which thread it is: unnamed, called by its characters.
          assert.deepStrictEqual(rows("threads").find((f) => f.forkId === docks)?.thread, {
            name: null,
            cast: [t.wren]
          })
          assert.deepStrictEqual(rows("threads").find((f) => f.forkId === F)?.thread, { name: null, cast: [t.mira] })
          assert.deepStrictEqual(
            [...rows("pinnedBranches"), ...rows("peers"), ...rows("other")].map((f) => f.forkId),
            [aside.id]
          )
          assert.strictEqual(rows("threads")[0]!.branches, 2)

          // A note saved in this thread, then copied to the other: the same text there, once.
          const here = { chatId: t.chatId, forkId: F, slotId: null }
          const opened = yield* api.OpenEditor({ refId: note.id, chatNote: here })
          const field = textField(["content"])
          const draft = yield* api.SaveEditorDraft({
            refId: note.id,
            field,
            scope: opened.chatNote!.scope,
            draftId: null,
            content: "Fog over the harbor.",
            expectedRowVersion: null,
            expectedSession: null,
            baseRevisionId: opened.ref.headRevisionId
          })
          yield* api.CommitEditorDrafts({
            refId: note.id,
            chatNote: here,
            expectedRowVersion: (yield* api.OpenEditor({ refId: note.id, chatNote: here })).ref.rowVersion,
            fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
            message: null
          })
          const textIn = (forkId: ForkId) =>
            Effect.map(
              api.ListChatNotes({ chatId: t.chatId, forkId, slotId: forkId === aside.id ? t.made.sent.slotId : S }),
              (notes) => notes.find((n) => n.ref.id === note.id)?.doc.content
            )
          assert.strictEqual(yield* textIn(F), "Fog over the harbor.")
          assert.notStrictEqual(yield* textIn(docks), "Fog over the harbor.")
          const copy = { chatId: t.chatId, noteRefId: note.id, fromForkId: F, toForkId: docks }
          assert.isTrue(yield* api.CopyNoteToBranch(copy))
          assert.strictEqual(yield* textIn(docks), "Fog over the harbor.")
          assert.isFalse(yield* api.CopyNoteToBranch(copy), "the same text there already")
          // Only the branch named: the earlier branch keeps its own.
          assert.notStrictEqual(yield* textIn(aside.id), "Fog over the harbor.")
          assert.strictEqual(yield* outcome(api.CopyNoteToBranch({ ...copy, toForkId: F })), "NotFound")
        })
      )
  )

  it.live("at the newest message: nothing is corrected; refusals and another user's probes", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story(null)
        const { api, F, S } = t
        const threads = [
          { name: null, cast: [t.mira], writesAs: null },
          { name: null, cast: [t.wren], writesAs: null }
        ]
        const at = { chatId: t.chatId, forkId: F, slotId: S }
        const version = yield* t.rowVersion(S, F)
        assert.strictEqual(
          yield* outcome(api.StartThreads({ ...at, expectedRowVersion: version, threads: threads.slice(0, 1) })),
          "ThreadsRefused"
        )
        assert.strictEqual(
          yield* outcome(
            api.StartThreads({
              ...at,
              expectedRowVersion: version,
              threads: [threads[0]!, { name: null, cast: [], writesAs: null }]
            })
          ),
          "ThreadsRefused"
        )
        assert.strictEqual(
          yield* outcome(api.StartThreads({ ...at, expectedRowVersion: version + 1, threads })),
          "StaleWrite"
        )
        // Not on F's path: a message only another branch has.
        const { fork: other } = yield* api.CreateFork({ chatId: t.chatId, fromForkId: F, atSlotId: S })
        const elsewhere = yield* t.append(other.id, S, t.user, "Elsewhere.")
        assert.strictEqual(
          yield* outcome(
            api.StartThreads({
              ...at,
              slotId: elsewhere.slotId,
              expectedRowVersion: yield* t.rowVersion(elsewhere.slotId, other.id),
              threads
            })
          ),
          "StaleWrite"
        )

        // At the newest message of a branch: its thread and a new one, both starting there.
        const started = yield* api.StartThreads({
          ...at,
          forkId: other.id,
          slotId: elsewhere.slotId,
          expectedRowVersion: yield* t.rowVersion(elsewhere.slotId, other.id),
          threads
        })
        assert.deepStrictEqual(started.forkIds[0], other.id)
        assert.strictEqual(started.forkIds.length, 2)
        // An unnamed thread shows no name; the UI names it by its characters.
        const [set] = yield* api.ThreadsOf({ chatId: t.chatId, forkId: started.forkIds[1]! })
        assert.deepStrictEqual(
          set!.threads.map((thread) => thread.name),
          [null, null]
        )

        // Another user: the chat, branch and split are NotFound to them.
        const other2 = yield* t.writer.EnsureUser({ handle: "threads-other", displayName: "Other" })
        const reader = t.reader
        assert.strictEqual(
          yield* outcome(reader.ThreadsOf({ userId: other2.id, chatId: t.chatId, forkId: F })),
          "NotFound"
        )
        assert.strictEqual(
          yield* outcome(
            t.writer.RenameThread({
              userId: other2.id,
              chatId: t.chatId,
              splitId: started.splitId,
              ordinal: 0,
              name: "x",
              rowVersion: 1
            })
          ),
          "NotFound"
        )
        assert.strictEqual(
          yield* outcome(t.writer.UndoThreads({ userId: other2.id, chatId: t.chatId, splitId: started.splitId })),
          "NotFound"
        )
        assert.strictEqual(
          yield* outcome(t.writer.StartThreads({ userId: other2.id, ...at, expectedRowVersion: version, threads })),
          "NotFound"
        )
      })
    )
  )
})
