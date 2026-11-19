// Two chats that merge with separate origins (DESIGN "Merging another chat into this one" [D]
// 2026-11-08; merge2): "Ledger", the destination, with Mira, Wren and Nara the narrator, the user
// playing Tobin; and "Docks", the source, with Kai and Lio. Helpers to write messages, marks and
// notes, to merge, and to capture the exact request of a reply by any character at any fork's
// tip. Synthetic data only.
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { MergeTimelines } from "@dreamspan/shared/mergeApi.ts"
import type { StateEventData } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../../src/assembler/types.ts"
import { Reader, Writer } from "../../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./config.ts"
import { cardDoc } from "./docs.ts"
import { fixtureSql } from "./lcmFixtures.ts"
import { generateReply } from "./generation.ts"
import { completionChunks, sse, startMockProvider } from "./mockProvider.ts"

export const sentText = (snapshot: ContextSnapshot) =>
  snapshot.request.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as ReadonlyArray<{ text?: string }>).map((p) => p.text ?? "").join("")
    )
    .join("\n")

interface At {
  readonly chatId: ChatId
  readonly forkId: ForkId
}

const story = (dataDir: string) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_request, res) =>
          sse(res, completionChunks(["The night goes on."], { prompt_tokens: 10, completion_tokens: 4 }))
        )
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const reader = yield* Reader
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const made = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      characters: ["Wren", "Nara"]
    })
    const mira = made.mira.entityId as EntityId
    const [wren, nara] = made.characters.map((card) => card.entityId as EntityId) as [EntityId, EntityId]
    const ledger: At = { chatId: made.chat.id, forkId: made.chat.currentForkId! as ForkId }
    const card = (name: string) =>
      Effect.map(
        writer.CreateEntity({
          userId,
          kind: "card",
          label: name,
          subtitle: "",
          doc: cardDoc(name),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        }),
        (c) => c.entityId as EntityId
      )
    const chat = (title: string, cast: ReadonlyArray<EntityId>) =>
      Effect.map(
        writer.CreateChat({ userId, kind: "rp", status: "active", title, participants: cast, greeting: null }),
        (c): At => ({ chatId: c.id, forkId: c.currentForkId! as ForkId })
      )
    const tip = (at: At) =>
      Effect.map(
        reader.ReadPath({
          userId,
          chatId: at.chatId,
          forkId: at.forkId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 1
        }),
        (path) => (path.entries.at(-1)?.slotId ?? null) as SlotId | null
      )
    const say = (at: At, speaker: EntityId | null, content: string) =>
      Effect.gen(function* () {
        const row = yield* writer.AppendMessage({
          userId,
          chatId: at.chatId,
          forkId: at.forkId,
          parentSlotId: yield* tip(at),
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: speaker,
            writer: speaker === null ? "human" : "model",
            content,
            status: "complete",
            macroMode: "verbatim",
            origin: speaker === null ? "user_written" : "generated"
          })
        })
        return row.slotId as SlotId
      })
    /** A state change at `at`'s newest message, from there on in that fork. */
    const mark = (at: At, data: StateEventData) =>
      Effect.gen(function* () {
        yield* writer.AddStateEvent({
          userId,
          chatId: at.chatId,
          forkId: at.forkId,
          slotId: yield* tip(at),
          versionId: null,
          scope: null,
          data
        })
      })
    const away = (at: At, entity: EntityId, isAway: boolean) =>
      mark(at, { key: "away.set", value: { entity, away: isAway } })
    /** A note of `owner`'s for its own turns only, on in every chat with the card. */
    const ownTurnNote = (owner: EntityId, content: string) =>
      writer.CreateEntity({
        userId,
        kind: "note",
        label: `${content} note`,
        subtitle: "",
        doc: {
          schema_version: 1,
          title: `${content} note`,
          content,
          owner: { card: owner },
          condition: { when: "own_turn" },
          placement: { mode: "section", section: "own_turn" },
          on_by_default: true,
          exportable: true
        },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const preview = (into: At, source: At, timelines?: MergeTimelines, at: SlotId | null = null) =>
      api.PreviewChatMerge({
        chatId: into.chatId,
        forkId: into.forkId,
        at,
        source: { chatId: source.chatId, forkId: source.forkId },
        includeLeftOut: true,
        ...(timelines ? { timelines } : {})
      })
    const merge = (into: At, source: At, timelines?: MergeTimelines, at: SlotId | null = null) =>
      Effect.gen(function* () {
        const seen = yield* preview(into, source, timelines, at)
        const merged = yield* api.MergeChat({
          chatId: into.chatId,
          forkId: into.forkId,
          at,
          source: { chatId: source.chatId, forkId: source.forkId },
          includeLeftOut: true,
          ...(timelines ? { timelines } : {}),
          title: seen.sourceTitle,
          framing: null,
          digest: seen.digest
        })
        return { preview: seen, slotId: merged.entry.slotId as SlotId }
      })
    /** The exact request of a reply by `speaker` at `at`'s newest message (a placeholder, never sent). */
    const requestFor = (at: At, speaker: EntityId, parent?: SlotId) =>
      Effect.gen(function* () {
        const placeholder = yield* writer.AppendMessage({
          userId,
          chatId: at.chatId,
          forkId: at.forkId,
          parentSlotId: parent ?? (yield* tip(at)),
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
          chatId: at.chatId,
          slotId: placeholder.slotId,
          versionId: placeholder.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null,
          forkId: placeholder.forkId
        })
        return JSON.parse(built.snapshot) as ContextSnapshot
      })
    /** A join's stored row, read beside the server on the database file. */
    const stored = (slotId: SlotId) =>
      Effect.map(
        fixtureSql(
          dataDir,
          [
            {
              sql: "SELECT timelines, split_id, stretch_before_slot_id, cast_json FROM chat_merges WHERE slot_id = ?",
              params: [slotId]
            }
          ],
          { readOnly: true }
        ),
        (rows) =>
          rows[0]![0] as {
            timelines: string
            split_id: string | null
            stretch_before_slot_id: string | null
            cast_json: string
          }
      )
    // Nara narrates the Ledger: she reads everything (CHARACTER-CONTEXT §6, today's default).
    yield* mark(ledger, { key: "cast.role", value: { entity: nara, role: "narrator" } })
    return {
      api,
      dataDir,
      mock,
      model: made.model,
      events: made.events,
      reader,
      writer,
      userId,
      mira,
      wren,
      nara,
      ledger,
      card,
      chat,
      tip,
      say,
      mark,
      away,
      ownTurnNote,
      preview,
      merge,
      requestFor,
      stored
    }
  })

export type MergeOriginStory = Effect.Success<ReturnType<typeof story>>

export const runMergeStory = <A, E, R>(use: (t: MergeOriginStory) => Effect.Effect<A, E, R>) => {
  const config = testConfig()
  return Effect.gen(function* () {
    return yield* use(yield* story(config.dataDir))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
}
