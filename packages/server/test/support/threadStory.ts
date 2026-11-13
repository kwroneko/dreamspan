// A chat of four parallel threads for the join tests (spec/THREADS.md §7): Mira at the Lantern
// (the branch the threads started in), Wren at the docks, Pell upstairs and Quill in the garden,
// the user playing Tobin, and optionally Nara, a narrator in every thread. Synthetic data only.
import { DatabaseSync } from "node:sqlite"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { MergeTimelines } from "@rp/shared/mergeApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { awayAt } from "@rp/shared/knowledge.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../../src/assembler/types.ts"
import { databaseFile } from "../../src/db/connection.ts"
import { Reader, Writer } from "../../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./config.ts"
import { generateReply } from "./generation.ts"
import { completionChunks, sse, startMockProvider } from "./mockProvider.ts"

const mockProvider = Effect.acquireRelease(
  Effect.promise(() =>
    startMockProvider((_request, res) =>
      sse(res, completionChunks(["The night goes on."], { prompt_tokens: 10, completion_tokens: 4 }))
    )
  ),
  (m) => Effect.promise(() => m.close())
)

export const sentText = (snapshot: ContextSnapshot) =>
  snapshot.request.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as ReadonlyArray<{ text?: string }>).map((p) => p.text ?? "").join("")
    )
    .join("\n")

const story = (dataDir: string, setting: "separate" | null, narrator: boolean) =>
  Effect.gen(function* () {
    const mock = yield* mockProvider
    const api = yield* client()
    const reader = yield* Reader
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const made = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      characters: narrator ? ["Wren", "Pell", "Quill", "Nara"] : ["Wren", "Pell", "Quill"],
      state: setting ? [{ key: "context.per_speaker", value: setting }] : []
    })
    const chatId = made.chat.id
    const mira = made.mira.entityId as EntityId
    const [wren, pell, quill, nara] = made.characters.map((card) => card.entityId as EntityId) as [
      EntityId,
      EntityId,
      EntityId,
      EntityId | undefined
    ]
    const F = made.chat.currentForkId! as ForkId
    const S = made.version.slotId as SlotId
    // A narrator is in every thread: it's never away (spec/THREADS.md §3.4).
    if (nara !== undefined)
      yield* writer.AddStateEvent({
        userId,
        chatId,
        forkId: F,
        slotId: S,
        versionId: null,
        scope: null,
        data: { key: "cast.role", value: { entity: nara, role: "narrator" } }
      })
    const tobin = foldState(yield* reader.StateEventsAt({ userId, chatId, slotId: S, forkId: F }))
      .playedByMe[0] as EntityId
    const rowVersion = (slotId: SlotId, forkId: ForkId) =>
      Effect.map(reader.GetSlot({ userId, slotId, forkId }), (slot) => slot.entry.rowVersion)
    // A branch made before the threads: never one of them.
    const before = (yield* writer.CreateFork({ userId, chatId, fromForkId: F, atSlotId: S })).fork.id as ForkId
    const started = yield* api.StartThreads({
      chatId,
      forkId: F,
      slotId: S,
      expectedRowVersion: yield* rowVersion(S, F),
      threads: [
        { name: "At the Lantern", cast: [mira], writesAs: null },
        { name: "At the docks", cast: [wren], writesAs: null },
        { name: "Upstairs", cast: [pell], writesAs: null },
        { name: "In the garden", cast: [quill], writesAs: null }
      ]
    })
    const [, D, U, G] = started.forkIds as [ForkId, ForkId, ForkId, ForkId]
    const append = (fork: ForkId, speaker: EntityId, content: string, model = true) =>
      Effect.gen(function* () {
        const tip = (yield* reader.ReadPath({
          userId,
          chatId,
          forkId: fork,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 1
        })).entries.at(-1)!.slotId
        return yield* writer.AppendMessage({
          userId,
          chatId,
          forkId: fork,
          parentSlotId: tip,
          branch: false,
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
      })
    /** Who is away at `slotId` (null: the tip) in `fork`. */
    const awayIn = (fork: ForkId, slotId: SlotId) =>
      Effect.map(reader.StateEventsAt({ userId, chatId, slotId, forkId: fork }), (events) => awayAt(foldState(events)))
    /** The request of a reply by `speaker` at the tip of `fork`: its own placeholder row (a branch there). */
    const requestFor = (fork: ForkId, speaker: EntityId) =>
      Effect.gen(function* () {
        const tip = (yield* reader.ReadPath({
          userId,
          chatId,
          forkId: fork,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 1
        })).entries.at(-1)!.slotId
        // A placeholder: generating, never sent.
        const placeholder = yield* writer.AppendMessage({
          userId,
          chatId,
          forkId: fork,
          parentSlotId: tip,
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
          slotId: placeholder.slotId,
          versionId: placeholder.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null,
          forkId: placeholder.forkId
        })
        return JSON.parse(built.snapshot) as ContextSnapshot
      })
    /** What that request sends, as one text. */
    const contextFor = (fork: ForkId, speaker: EntityId) => Effect.map(requestFor(fork, speaker), sentText)
    /** The stored rows of the join at `slotId`, read beside the server on the database file. */
    const stored = (slotId: SlotId) => {
      const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
      try {
        const merge = db
          .prepare("SELECT id, split_id, timelines, title, cast_json FROM chat_merges WHERE slot_id = ?")
          .get(slotId) as { id: string; split_id: string | null; timelines: string; title: string; cast_json: string }
        const rows = db
          .prepare(
            `SELECT kind, source_slot_id, source_version_id, media_json, knowers_json, content FROM chat_merge_messages
              WHERE merge_id = ? ORDER BY ordinal`
          )
          .all(merge.id) as Array<{
          kind: string
          source_slot_id: string | null
          source_version_id: string | null
          media_json: string | null
          knowers_json: string | null
          content: string
        }>
        return { merge, rows }
      } finally {
        db.close()
      }
    }
    /** The recorded stretch slots of the separate joins in `fork`'s chat (thread_stretch_slots). */
    const stretchOf = (_fork: ForkId) => {
      const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
      try {
        return db
          .prepare(
            `SELECT t.slot_id, t.opens, s.inserted FROM thread_stretch_slots t JOIN chat_merges m ON m.id = t.merge_id
              JOIN slots s ON s.id = t.slot_id WHERE m.chat_id = ?`
          )
          .all(chatId) as Array<{ slot_id: string; opens: number; inserted: number }>
      } finally {
        db.close()
      }
    }
    const preview = (into: ForkId, source: ForkId, at: SlotId | null = null, timelines?: MergeTimelines) =>
      api.PreviewChatMerge({
        chatId,
        forkId: into,
        at,
        source: { chatId, forkId: source },
        includeLeftOut: false,
        ...(timelines ? { timelines } : {})
      })
    const join = (into: ForkId, sources: ReadonlyArray<ForkId>, at: SlotId | null = null, timelines?: MergeTimelines) =>
      Effect.gen(function* () {
        const previews = yield* Effect.forEach(sources, (source) => preview(into, source, at, timelines))
        return yield* api.JoinThreads({
          chatId,
          forkId: into,
          at,
          includeLeftOut: false,
          ...(timelines ? { timelines } : {}),
          joins: previews.map((p, i) => ({
            forkId: sources[i]!,
            title: p.sourceTitle,
            framing: null,
            digest: p.digest
          }))
        })
      })
    return {
      api,
      reader,
      writer,
      userId,
      chatId,
      mira,
      wren,
      pell,
      quill,
      nara,
      tobin,
      F,
      D,
      U,
      G,
      S,
      before,
      splitId: started.splitId,
      append,
      awayIn,
      contextFor,
      requestFor,
      stored,
      stretchOf,
      preview,
      join
    }
  })

export type ThreadStory = Effect.Success<ReturnType<typeof story>>

export const runStory = <A, E, R>(
  setting: "separate" | null,
  use: (t: ThreadStory) => Effect.Effect<A, E, R>,
  options: { readonly narrator?: boolean } = {}
) => {
  const config = testConfig()
  return Effect.gen(function* () {
    return yield* use(yield* story(config.dataDir, setting, options.narrator ?? false))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
}
