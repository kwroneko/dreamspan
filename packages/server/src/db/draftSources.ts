// The assembler's sources for a chat not made yet (DESIGN §2.1, "A chat not sent yet shows its
// context size"): what `StartChat` would write, stood in for in memory, so the first send's
// request is built by the same pipeline without writing anything. Library reads (cards, notes,
// lorebooks, the preset, the model, the global scripts) are the database sources' own, as the
// first send reads them; the chat's own parts (its starting events, the greetings as picked, the
// typed message and the reply after it) come from the draft. A card from a card source has no
// row yet: its document and Character's Note come with the draft, under its placeholder id.
import { imagesOnly, type EntityId } from "@dreamspan/shared/chat.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { NoteDoc } from "@dreamspan/shared/docs/note.ts"
import type { CardDoc } from "@dreamspan/shared/docs/card.ts"
import type { FirstTurn } from "@dreamspan/shared/chatSetupApi.ts"
import type { FoldableEvent } from "@dreamspan/shared/state.ts"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/sql"
import { AssemblySources, type PositionedEvent } from "../assembler/pipeline.ts"
import { mediaHeldBy } from "./media.ts"
import type { CardInput, HistoryEntry, NoteInput, PresetInput } from "../assembler/types.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { sqlSources } from "./assemblySources.ts"
import { newChatLcmSettings } from "./generationSettings.ts"
import type { ChatId } from "@dreamspan/shared/chat.ts"

/** The chat id the draft's sources answer to: no chat has it, so no chat-owned row is read. */
const DRAFT_CHAT = "draft" as ChatId

/** A greeter as `StartChat` takes it (`greeters` in ops.ts), its options frozen and picked. */
interface DraftGreeter {
  readonly entityId: string
  readonly greeting: number | null
  readonly options: ReadonlyArray<{
    readonly index: number
    readonly text: string
    readonly frozen: Readonly<Record<string, string>> | null
  }>
}

export interface Draft {
  readonly userId: UserId
  readonly cards: ReadonlyArray<EntityId>
  readonly persona: EntityId | null
  readonly greeters: ReadonlyArray<DraftGreeter>
  readonly first: FirstTurn
  /** Who answers a sent message, as the client's Generate after the send names them. */
  readonly replier: EntityId | null
  /** Cards from a card source, by placeholder id: their documents and notes as adding them stores them. */
  readonly remote: ReadonlyArray<{
    readonly entity: string
    readonly docJson: string
    readonly notes: ReadonlyArray<string>
  }>
  readonly now: number
  /** A pending workshop can choose its own preset before its first message. */
  readonly preset?: RefId | PresetInput | null
}

const at = (data: FoldableEvent["data"]): PositionedEvent => ({ depth: null, event: { scope: null, data } })

export const draftSources = (sql: SqlClient.SqlClient, draft: Draft) =>
  Effect.gen(function* () {
    const base = sqlSources(sql, { userId: draft.userId, chatId: DRAFT_CHAT, next: true })
    const live = base.service
    // StartChat's events: the chat's summarization settings, each card joining (the persona
    // last, once), and the persona played by the user.
    const joined = [...new Set([...draft.cards, ...(draft.persona === null ? [] : [draft.persona])])]
    const lcm = yield* newChatLcmSettings(sql, draft.userId)
    const preset = draft.preset
    const events: ReadonlyArray<PositionedEvent> = [
      at({ key: "lcm.settings", value: lcm } as FoldableEvent["data"]),
      ...(preset === null || typeof preset === "string"
        ? [at({ key: "preset.binding", value: preset === null ? {} : { ref: preset } })]
        : []),
      ...joined.map((entity) => at({ key: "participant.join", value: { entity } } as FoldableEvent["data"])),
      ...(draft.persona === null
        ? []
        : [at({ key: "played_by_me.set", value: { entities: [draft.persona] } } as FoldableEvent["data"])])
    ]
    // Each greeter's greeting as picked, a message of its own; then the message typed.
    const entries: Array<HistoryEntry> = []
    const slot = (i: number) => `draft-slot-${i}`
    for (const greeter of draft.greeters) {
      if (greeter.options.length === 0) continue
      const picked = Math.max(
        0,
        greeter.options.findIndex((option) => option.index === greeter.greeting)
      )
      const option = greeter.options[picked]!
      const i = entries.length
      entries.push({
        slotId: slot(i),
        versionId: `draft-version-${i}`,
        depth: i,
        speaker: greeter.entityId,
        side: "assistant",
        content: option.text,
        macroMode: "template",
        frozen: option.frozen && Object.keys(option.frozen).length > 0 ? option.frozen : null,
        written: false,
        inContext: option.text.length > 0,
        sentAt: draft.now,
        versions: greeter.options.length,
        selectedOrdinal: picked,
        versionNumber: picked + 1
      })
    }
    if (draft.first._tag === "Send") {
      const images = yield* Effect.forEach(imagesOnly(draft.first.images ?? []), (image) =>
        Effect.gen(function* () {
          const [media] = yield* sql<{ sha256: string; width: number | null; height: number | null }>`
            SELECT m.sha256, m.width, m.height FROM media_assets m
            WHERE m.id = ${image.mediaId} AND m.mime IN ('image/png','image/jpeg','image/gif','image/webp')
              AND ${mediaHeldBy(sql, "m.id", draft.userId)}`
          if (!media) return yield* new NotFound({ entity: "media", id: image.mediaId })
          return { mediaId: image.mediaId, ...media }
        })
      )
      const i = entries.length
      entries.push({
        slotId: slot(i),
        versionId: `draft-version-${i}`,
        depth: i,
        speaker: draft.first.speakerEntityId,
        side: "user",
        content: draft.first.content,
        ...(images.length ? { images } : {}),
        macroMode: "verbatim",
        frozen: null,
        written: false,
        inContext: draft.first.content.length > 0 || images.length > 0,
        sentAt: draft.now,
        versions: 1,
        selectedOrdinal: 0,
        versionNumber: 1
      })
    }
    const n = entries.length
    const direction =
      draft.first._tag === "Generate" && draft.first.direction.trim() !== "" ? draft.first.direction : null
    const remote = new Map(draft.remote.map((card) => [card.entity, card]))
    const remoteCards = new Map<string, CardInput>(
      draft.remote.map((card) => [
        card.entity,
        { entity: card.entity, ref: null, revision: `draft:${card.entity}`, doc: JSON.parse(card.docJson) as CardDoc }
      ])
    )
    const index = (slotId: string | null) => (slotId === null ? -1 : entries.findIndex((e) => e.slotId === slotId))
    const sources = AssemblySources.of({
      ...live,
      ...(typeof preset === "object" && preset !== null ? { preset: () => Effect.succeed(preset) } : {}),
      viewLayers: true,
      summaryLayer: () => Effect.succeed({ summaries: [], cursor: null, cursorDepth: -1, failures: [] }),
      target: Effect.succeed({
        chatId: DRAFT_CHAT,
        slotId: slot(n),
        versionId: `draft-version-${n}`,
        depth: n,
        parentSlotId: n === 0 ? null : slot(n - 1),
        ordinal: 0,
        speaker: draft.first._tag === "Send" ? draft.replier : draft.first.speakerEntityId,
        direction
      }),
      historyStart: () => Effect.succeed(null),
      historyRevision: () => Effect.succeed(0),
      events: () => Effect.succeed(events),
      history: (leaf, limit, after) =>
        Effect.sync(() => {
          const end = index(leaf)
          const boundary = after === undefined ? 0 : index(after) + 1
          const start = Math.max(boundary, end - limit + 1)
          return { entries: entries.slice(start, end + 1), older: start <= boundary ? null : slot(start - 1) }
        }),
      cards: (entities, bindings) =>
        Effect.map(
          live.cards(
            entities.filter((entity) => !remote.has(entity)),
            bindings
          ),
          (local) => {
            const found = new Map(local.map((card) => [card.entity, card]))
            for (const [entity, card] of remoteCards) found.set(entity, card)
            return entities.flatMap((entity) => (found.has(entity) ? [found.get(entity)!] : []))
          }
        ),
      // A source's card's notes are made when it's added, after every note the user has.
      notes: (cards, bound) =>
        Effect.map(live.notes(cards, bound), (notes): ReadonlyArray<NoteInput> => [
          ...notes,
          ...draft.remote.flatMap((card) =>
            cards.includes(card.entity)
              ? card.notes.map((json, i) => ({
                  entity: `draft-note:${card.entity}:${i}`,
                  revision: `draft-note:${card.entity}:${i}`,
                  doc: { ...(JSON.parse(json) as NoteDoc), owner: { card: card.entity as EntityId } }
                }))
              : []
          )
        ]),
      onPath: (leaf, slots) =>
        Effect.sync(() => {
          const end = index(leaf)
          return new Set(slots.filter((s) => index(s) !== -1 && index(s) <= end))
        }),
      // No reply has run, so no entry's timing has started: the path's messages count, nothing else.
      loreState: (leaf) =>
        Effect.succeed({ count: entries.slice(0, index(leaf) + 1).filter((e) => e.inContext).length, effects: [] }),
      messageCount: (leaf) => Effect.succeed(entries.slice(0, index(leaf) + 1).filter((e) => e.inContext).length),
      knowers: (versionIds) => Effect.succeed(versionIds.map((versionId) => ({ versionId, knowers: null }))),
      mergeRows: () => Effect.succeed([]),
      knewThrough: () => Effect.succeed(true)
    })
    return {
      layer: Layer.succeed(AssemblySources)(sources),
      /** The model the first send would use: the user's default (a new chat binds none). */
      model: () => live.model(null),
      resolvedModel: base.resolvedModel,
      chosenModel: base.chosenModel
    }
  })
