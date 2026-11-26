import { workshopHistory } from "../agent/workshopHistory.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { loreEffectsAt, type LoreReceipt, type LoreTimeline } from "../assembler/loreTiming.ts"
import { refSourcePathSql } from "./library.ts"
import { hasVersionPayload, libraryDocuments } from "./libraryAttachments.ts"
import { bookSourceName } from "@dreamspan/shared/lorebookLink.ts"
import { sharedNote } from "./sharedNotes.ts"
import { originalReply, type ReplySections } from "@dreamspan/shared/replySections.ts"
import { eventApplies, eventOrder } from "./forkState.ts"
import { withModelSettings } from "@dreamspan/shared/modelSettings.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { pathEvents } from "./pathSegments.ts"
import {
  attachedApplies,
  imageExcludedIn,
  originalSql,
  shownIn,
  slotDeletedIn,
  thinkingHiddenIn,
  versionDeletedIn,
  viewAt
} from "./forkState.ts"
import { hiddenParts } from "./rows.ts"
import { selectSummaryLayer, selectFailedRanges, type LayerView } from "./lcmLayer.ts"
import { readSummary } from "./lcmReads.ts"
// The assembler's sources over the database, every read the acting user's, and the pins a
// rebuild reads again (ARCHITECTURE §15).
import { documentedCachePolicy } from "../providers/cachePolicy.ts"
import { findProvider, resolveProviderSettings, isOpenRouterEndpoint } from "@dreamspan/shared/providerDefinitions.ts"
import { CurrentProviderDefinitions } from "../providers/definitions.ts"
import { prefillUnavailable } from "../assembler/prefill.ts"
import { mappingCapabilities } from "../providers/mapping.ts"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { CardDoc } from "@dreamspan/shared/docs/card.ts"
import { LorebookDoc } from "@dreamspan/shared/docs/lorebook.ts"
import { NoteDoc } from "@dreamspan/shared/docs/note.ts"
import { LegacyPresetDoc as PresetDoc } from "@dreamspan/shared/docs/preset.ts"
import { withEndOfRequest } from "@dreamspan/shared/presetConditions.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import type { Summary } from "@dreamspan/shared/lcm.ts"
import { isStretchView, knowsSql, readKnowers, readMergeRows } from "./knowers.ts"
import { threadStretches } from "./threadStretches.ts"
import { audienceKey, firstUnknownPosition, stretchOnPath } from "./lcmAudience.ts"
import { resolveModel } from "@dreamspan/shared/providers.ts"
import { FoldableEvent } from "@dreamspan/shared/state.ts"
import { Effect, Layer, Schema } from "effect"
import type { Fragment } from "effect/sql/Statement"
import type { SqlClient, SqlError } from "effect/sql"
import type { PathPiece } from "./displayPath.ts"
import { AssemblySources, type PositionedEvent } from "../assembler/pipeline.ts"
import {
  AssemblyFailed,
  type ModelInput,
  type CardInput,
  type HistoryEntry,
  type HistoryLibraryItem,
  type HistoryMerge,
  type NoteInput,
  type LorebookInput,
  noteCard,
  type PresetInput,
  type SnapshotInputs,
  type SourcePins,
  type Target
} from "../assembler/types.ts"
import { forbidCardOverrides, importStPreset } from "../formats/preset.ts"
import { agentInstructionsPrompt } from "@dreamspan/shared/presetOrder.ts"
import {
  connectionColumns,
  connectionFrom,
  type ConnectionRow,
  type ModelRow,
  toConnection,
  toModel
} from "./providers.ts"
import type { GenerationDefaults } from "@dreamspan/shared/generation.ts"
import { readDefaults, readGlobalRegex } from "./generationSettings.ts"
import { displayHistoryRevision, historyRevision } from "./historyChanges.ts"
import { previousStartIn, withHistoryCheckpoint } from "./historyStart.ts"
import {
  displayEnd,
  displayEndOf,
  displayEvents,
  displayLength,
  displaySlots,
  displayThrough,
  pathPieces,
  positionOf,
  slotAtPosition,
  slotPlace
} from "./displayPath.ts"
import { noteHistory } from "./noteHistory.ts"
import { withoutOrphanNoteActivations } from "./agentNotes.ts"
import { withoutPurged } from "./stateRefs.ts"

/** Stored image facts for assembly and its draft preview, always inside a reader worker. */
export const readImageTokenFacts = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  model: { readonly connectionId: string; readonly kind: string; readonly modelKey: string },
  sha256s: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const counts =
      sha256s.length === 0
        ? []
        : yield* sql<{ sha256: string; detail: string; tokens: number }>`
                SELECT sha256, detail, tokens FROM image_token_counts
                WHERE owner_user_id = ${userId} AND kind = ${model.kind} AND model_key = ${model.modelKey}
                  AND sha256 IN ${sql.in(sha256s)}`
    const samples = yield* sql<{ images: number; pixels: number; tokens: number }>`
          SELECT images, pixels, tokens FROM image_token_samples
          WHERE owner_user_id = ${userId} AND connection_id = ${model.connectionId} AND model_key = ${model.modelKey}
          ORDER BY id DESC LIMIT 20`
    return { counts: [...counts], samples: [...samples] }
  })

const decodeEvent = Schema.decodeUnknownEffect(FoldableEvent)
const decodeCard = Schema.decodeUnknownExit(CardDoc)
const decodeLorebook = Schema.decodeUnknownExit(LorebookDoc)
const decodeNote = Schema.decodeUnknownExit(NoteDoc)
const decodePreset = Schema.decodeUnknownExit(PresetDoc)

const stDefaults = forbidCardOverrides(
  importStPreset(JSON.stringify({ frequency_penalty: 0, group_nudge_prompt: "", impersonation_prompt: "" })).document!
)

/**
 * The built-in preset uses our end-of-request defaults; ST imports retain their own wording. Its
 * Agent instructions come last in the order, empty: the app's default with the end of the
 * request, as a preset without them sends it.
 */
export const builtinPreset = {
  ...stDefaults,
  prompts: [...stDefaults.prompts, agentInstructionsPrompt],
  order: [...stDefaults.order, { identifier: agentInstructionsPrompt.identifier, enabled: true }]
}

const invalid = (what: string) =>
  new AssemblyFailed({
    reason: "invalid_document",
    message: `${what} doesn't match its format any more, so it can't be used. Edit it, or choose another.`
  })

const decoded = <A>(
  exit:
    | ReturnType<typeof decodeCard>
    | ReturnType<typeof decodeNote>
    | ReturnType<typeof decodePreset>
    | ReturnType<typeof decodeLorebook>,
  what: string
) => (exit._tag === "Success" ? Effect.succeed(exit.value as A) : Effect.fail(invalid(what)))

/** A history message's leading tagged sections, for the preset to send back. */
const sectionsOf = (json: string | null): { replySections?: ReplySections } =>
  json === null ? {} : { replySections: JSON.parse(json) as ReplySections }

/** A join as the history reads it: its view only when separate, so a together join reads as before. */
const historyMerge = (json: string): HistoryMerge => {
  const { timelines, ...merge } = JSON.parse(json) as HistoryMerge & { readonly timelines: string }
  return timelines === "separate" ? { ...merge, timelines: "separate" } : merge
}

interface HistoryRow {
  readonly workshop_transcript: string | null
  readonly images_json: string
  /** Its attachments saved in Files (§6.1), for the `<attachment>` lines. */
  readonly attachments_json: string
  /** Its library items with their documents at the recorded revisions (WORKSHOP-CARDS §4.3). */
  readonly library_json: string
  readonly merge_json: string | null
  readonly slot_id: string
  readonly parent_slot_id: string | null
  readonly depth: number
  readonly context_excluded: number
  readonly slot_deleted: number
  readonly version_id: string
  readonly ordinal: number
  readonly version_number: number
  readonly status: string
  readonly speaker_entity_id: string | null
  readonly content: string
  readonly reply_sections: string | null
  readonly macro_mode: "template" | "verbatim"
  readonly frozen_macros: string | null
  readonly created_at: number
  readonly version_count: number
  readonly first_writer: string
  readonly first_origin: string
  readonly amend_count: number
  readonly written: number
  readonly inserted?: number
  readonly hidden_thinking: number
}

/**
 * The version being generated, or `next`: a reply not yet asked for, at the end of the
 * requested path (active by default), the request the cache-warmth estimate compares (DESIGN §5.5).
 */
type Settings = {
  readonly workshopHistory?: true
  readonly cut?: string
  readonly summaryBefore?: { readonly slot: string | null; readonly depth: number }
  readonly partialBatch?: boolean
  /** A condensation's request: the layer before `summaryBefore`, then exactly these parts, ending at `cursor`. */
  readonly condense?: {
    readonly children: ReadonlyArray<Summary>
    readonly cursor: string
    readonly cursorDepth: number
  }
  /** A model chosen for this context over the chat's bindings: "Retry with…", a summary job's fallback. */
  readonly modelOverride?: { readonly connection: string; readonly model: string }
} & (
  | { readonly userId: UserId; readonly chatId: ChatId; readonly slotId: string; readonly versionId: string }
  | { readonly userId: UserId; readonly chatId: ChatId; readonly next: true; readonly leafSlotId?: string | null }
)

/** A snapshot to read again: its pins and its inputs. */
interface Replay {
  readonly pins: SourcePins
  readonly inputs: SnapshotInputs
}

/** Why a snapshot can't be read again. */
const unpinned = (what: string) =>
  new AssemblyFailed({
    reason: "invalid_document",
    message: `The context can't be built again: ${what} it was built from is gone.`
  })

const keyOf = (...args: ReadonlyArray<unknown>) => JSON.stringify(args)

/**
 * The sources over the database, and what they read, pinned (`SourcePins`). Given a
 * snapshot's pins, they read those again instead: the same events, versions at the same
 * amend, the same revisions, the model and preset revision the snapshot recorded.
 */
export const sqlSources = (sql: SqlClient.SqlClient, settings: Settings, replay?: Replay) => {
  const { userId, chatId } = settings
  // The user's defaults, read once for the model and the preset both.
  let readOnce: GenerationDefaults | undefined
  const defaults = Effect.suspend(() =>
    readOnce
      ? Effect.succeed(readOnce)
      : Effect.map(readDefaults(sql, userId), (read) => {
          readOnce = read
          return read
        })
  )
  // Every read of the chat checks it's the user's, not only the target's: a stage that
  // replaced `path` couldn't read another user's chat through the others.
  const owned = sql`EXISTS (SELECT 1 FROM chats o WHERE o.id = ${chatId} AND o.owner_user_id = ${userId})`
  // The versions read are those the fork in view shows (ForkView; else the fork through the
  // leaf): its selections, as it replaces them.
  const shown = (leaf: string | null, s: string) =>
    Effect.map(viewAt(sql, chatId, leaf), (fork) => shownIn(sql, fork, s))
  // Whether an event attached to a version applies there in that fork (`attachedApplies`).
  const attached = (leaf: string | null, s: string, column: string) =>
    Effect.map(viewAt(sql, chatId, leaf), (fork) => attachedApplies(sql, fork, s, column))
  // The display path through a slot in the fork in view (spec/MESSAGE-INSERT.md §3.2), when
  // the fork places insertions: positions then stand for depths in everything read below
  // (a message's, an event's, the target's, the history start's). Null without insertions,
  // and every read is the structural one, as before.
  const displayed = new Map<string, { readonly pieces: ReadonlyArray<PathPiece>; readonly end: number } | null>()
  const display = (leaf: string | null) =>
    Effect.gen(function* () {
      const fork = yield* viewAt(sql, chatId, leaf)
      const key = keyOf(fork, leaf)
      if (!displayed.has(key)) displayed.set(key, yield* displayThrough(sql, chatId, fork, leaf))
      return displayed.get(key)!
    })
  const positionIn = (pieces: ReadonlyArray<PathPiece>, slotId: string) =>
    Effect.map(slotPlace(sql, chatId, slotId), (place) => (place === null ? null : positionOf(pieces, place)))
  /**
   * A target at its display position, with the message before it there when that isn't its
   * parent (`historyLeaf`). A reply after the fork's tip follows the tip's insertions, which
   * the display end is the last of (§2.4); one after another message (a cut) follows that.
   */
  const placeTarget = (target: Target, next: boolean) =>
    Effect.gen(function* () {
      const leaf = next ? target.parentSlotId : target.slotId
      const shown = yield* display(leaf)
      // A fork with no structural tip can still have insertions above the first message.
      if (shown === null && next && leaf === null) {
        const fork = yield* viewAt(sql, chatId, leaf)
        const pieces = yield* pathPieces(sql, chatId, fork, null)
        if (pieces.length > 0)
          return {
            ...target,
            depth: displayLength(pieces),
            historyLeaf: displayEnd(pieces, null),
            displayPositions: true
          }
      }
      if (shown === null) return target
      let depth = next ? shown.end + 1 : shown.end
      let before = next ? leaf : shown.end === 0 ? null : yield* slotAtPosition(sql, shown.pieces, shown.end - 1)
      if (next) {
        const fork = yield* viewAt(sql, chatId, leaf)
        const [tip] = yield* sql<{ tip_slot_id: string | null }>`SELECT tip_slot_id FROM forks WHERE id = ${fork}`
        if (tip?.tip_slot_id === leaf) {
          const pieces = yield* pathPieces(sql, chatId, fork, leaf)
          depth = displayLength(pieces)
          before = displayEnd(pieces, leaf)
        }
      }
      return {
        ...target,
        depth,
        displayPositions: true,
        ...(before === target.parentSlotId ? {} : { historyLeaf: before })
      } satisfies Target
    })
  /** A revision of an entity of this kind the user owns and hasn't deleted. */
  const revisionDoc = (revisionId: string, kind: string, entity?: string, binned = false) =>
    sql<{ entity_id: string; doc_json: string }>`
      SELECT v.entity_id, v.doc_json FROM entity_revisions v JOIN entities e ON e.id = v.entity_id
      WHERE v.id = ${revisionId} AND e.owner_user_id = ${userId} AND e.kind = ${kind}
        AND (${binned ? 1 : 0} OR e.deleted_at IS NULL)
        AND (${entity ?? null} IS NULL OR e.id = ${entity ?? null})`.pipe(Effect.map(([row]) => row))

  /**
   * A ref the user owns, with its head's document, and the file it or its nearest ancestor was
   * imported from: a fork answers to its original's ST name (a card's linked lorebook).
   */
  const refHead = (refId: string, kind: string, entity?: string) =>
    sql
      .unsafe<{
        id: string
        entity_id: string
        head_revision_id: string
        doc_json: string
        source_path: string | null
      }>(
        `SELECT r.id, r.entity_id, r.head_revision_id, h.doc_json, ${refSourcePathSql} AS source_path
      FROM entity_refs r
      JOIN entities e ON e.id = r.entity_id JOIN entity_revisions h ON h.id = r.head_revision_id
      WHERE r.id = ? AND e.owner_user_id = ? AND e.kind = ? AND e.deleted_at IS NULL
        AND (? IS NULL OR e.id = ?)`,
        [refId, userId, kind, entity ?? null, entity ?? null]
      )
      .pipe(Effect.map(([row]) => row))

  /** A card's single upstream ref when no revision is pinned. */
  const defaultRef = (entity: string) =>
    sql<{ id: string }>`
      SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
      WHERE r.entity_id = ${entity} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL
      LIMIT 1`.pipe(Effect.map(([row]) => row?.id ?? null))

  const card = (entity: string, binding: { ref?: string | undefined; revision?: string | undefined } | undefined) =>
    Effect.gen(function* () {
      if (binding?.revision) {
        const row = yield* revisionDoc(binding.revision, "card", entity)
        if (!row) return null
        const doc = yield* decoded<CardDoc>(decodeCard(JSON.parse(row.doc_json)), "A card")
        return { entity, ref: binding.ref ?? null, revision: binding.revision, doc } satisfies CardInput
      }
      const refId = binding?.ref ?? (yield* defaultRef(entity))
      if (refId === null) return null
      const row = yield* refHead(refId, "card", entity)
      if (!row) return null
      const doc = yield* decoded<CardDoc>(decodeCard(JSON.parse(row.doc_json)), "A card")
      return { entity, ref: row.id, revision: row.head_revision_id, doc } satisfies CardInput
    })

  const presetFrom = (
    binding: { ref?: string | undefined; revision?: string | undefined } | string,
    scope: PresetInput["scope"]
  ) =>
    Effect.gen(function* () {
      const { ref, revision } = typeof binding === "string" ? { ref: binding, revision: undefined } : binding
      const row = revision
        ? yield* Effect.map(
            revisionDoc(revision, "preset"),
            (r) => r && { ref: ref ?? null, revision, doc_json: r.doc_json }
          )
        : ref
          ? yield* Effect.map(
              refHead(ref, "preset"),
              (r) => r && { ref: r.id, revision: r.head_revision_id, doc_json: r.doc_json }
            )
          : undefined
      if (!row) return null
      const doc = yield* decoded<PresetDoc>(
        decodePreset({ ...builtinPreset, ...JSON.parse(row.doc_json) }),
        "The preset"
      )
      return { ref: row.ref, revision: row.revision, scope, doc: withEndOfRequest(doc).doc } satisfies PresetInput
    })

  let stretchPins: SourcePins["stretches"]
  let layerPins: SourcePins["lcm"]
  // Read only by a separate context, so pinned only when read: a shared one's snapshot is unchanged.
  const knowerPins: Array<NonNullable<SourcePins["knowers"]>[number]> = []
  const knewPins: Array<NonNullable<SourcePins["knewThrough"]>[number]> = []
  let resolvedModel: ModelInput | null = null
  /** The model the chat's binding or the user's default chose, read or not; unset before the model is read. */
  /** A shared note's library head, which a linked slot shows; a binned or missing one has none. */
  const sharedHead = (entity: string) =>
    Effect.gen(function* () {
      const shared = yield* sharedNote(sql, userId, entity)
      if (!shared || shared.deleted === 1 || (shared.scope !== "global" && shared.scope !== chatId))
        return { entity, revision: null, doc: null }
      const [row] = yield* sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions WHERE id = ${shared.head}`
      const doc = yield* decoded<NoteDoc>(decodeNote(JSON.parse(row!.doc_json)), "A shared note")
      return { entity, revision: shared.head, doc }
    })

  let chosenModel: ChosenModel | null | undefined
  const pins = {
    target: null as Target | null,
    historyStart: null as NonNullable<SourcePins["historyStart"]> | null,
    historyRevisions: {} as Record<string, number>,
    events: [] as Array<SourcePins["events"][number]>,
    history: [] as Array<SourcePins["history"][number]>,
    cards: [] as Array<SourcePins["cards"][number]>,
    lorebooks: [] as Array<NonNullable<SourcePins["lorebooks"]>[number]>,
    globalRegex: [] as NonNullable<SourcePins["globalRegex"]>,
    notes: [] as Array<SourcePins["notes"][number]>,
    loreStates: [] as Array<NonNullable<SourcePins["loreStates"]>[number]>,
    messageCount: [] as Array<NonNullable<SourcePins["messageCount"]>[number]>,
    lcmDefaults: undefined as SourcePins["lcmDefaults"],
    imageTokenFacts: undefined as SourcePins["imageTokenFacts"]
  }

  const pinTarget = (target: Target) =>
    Effect.sync(() => {
      pins.target = target
    })

  const versionTarget = (slotId: string, versionId: string) =>
    Effect.flatMap(viewAt(sql, chatId, slotId), (fork) =>
      sql<{
        depth: number
        parent_slot_id: string | null
        ordinal: number
        speaker_entity_id: string | null
        direction: string | null
        continues: string | null
        continued_text: string | null
        continued_sections: string | null
        continued_hidden: number
      }>`
      SELECT s.depth, s.parent_slot_id, v.ordinal, v.speaker_entity_id, v.direction,
        -- A generated version with a source continues it (ContinueVersion); the source is
        -- a version of the same slot (graphIntegrity.ts), frozen once it was written.
        CASE WHEN v.writer = 'model' AND v.origin = 'generated' THEN v.source_version_id END AS continues,
        (SELECT x.content FROM version_records x WHERE x.id = v.source_version_id AND x.slot_id = v.slot_id) AS continued_text,
        (SELECT x.reply_sections FROM version_records x WHERE x.id = v.source_version_id AND x.slot_id = v.slot_id)
          AS continued_sections,
        ${thinkingHiddenIn(sql, fork, "(SELECT CASE WHEN x.fork_id IS NULL THEN x.id ELSE x.source_version_id END FROM versions x WHERE x.id = v.source_version_id)")} AS continued_hidden
      FROM version_records v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
      WHERE v.id = ${versionId} AND s.id = ${slotId} AND c.id = ${chatId} AND c.owner_user_id = ${userId}
        AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`.pipe(
        Effect.flatMap(([row]) =>
          row
            ? Effect.succeed({
                chatId,
                slotId,
                versionId,
                depth: row.depth,
                parentSlotId: row.parent_slot_id,
                ordinal: row.ordinal,
                speaker: row.speaker_entity_id,
                direction: row.direction,
                ...(row.continues === null
                  ? {}
                  : {
                      // The reply as it came, its leading sections in their tags (spec/REPLY-SECTIONS.md).
                      continues: {
                        version: row.continues,
                        text: originalReply(
                          row.continued_text ?? "",
                          row.continued_sections === null || (row.continued_hidden & 2) !== 0
                            ? null
                            : (JSON.parse(row.continued_sections) as ReplySections)
                        )
                      }
                    })
              })
            : Effect.fail(new NotFound({ entity: "version", id: versionId }))
        ),
        Effect.flatMap((target) => placeTarget(target, false)),
        Effect.tap(pinTarget)
      )
    )

  const viewedLeaf = "next" in settings ? (settings.cut ?? settings.leafSlotId ?? null) : null
  const nextTarget = sql<{ leaf: string | null; depth: number | null }>`
    SELECT s.id AS leaf, s.depth FROM chats c LEFT JOIN slots s
      ON s.id = coalesce(${viewedLeaf}, c.active_leaf_slot_id) AND s.chat_id = c.id
    WHERE c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
      AND (${viewedLeaf} IS NULL OR (s.id IS NOT NULL AND (s.deleted_at IS NULL
        OR EXISTS (SELECT 1 FROM forks f WHERE f.chat_id = c.id AND f.tip_slot_id = s.id AND f.deleted_at IS NULL))))`.pipe(
    Effect.flatMap(([row]) =>
      row
        ? Effect.succeed({
            chatId,
            slotId: "",
            versionId: "",
            depth: row.depth === null ? 0 : row.depth + 1,
            parentSlotId: row.leaf,
            ordinal: 0,
            speaker: null,
            direction: null
          } satisfies Target)
        : Effect.fail(new NotFound({ entity: "chat", id: chatId }))
    ),
    Effect.flatMap((target) => placeTarget(target, true)),
    Effect.tap(pinTarget)
  )

  const history = noteHistory(sql, userId, chatId)
  const live = AssemblySources.of({
    viewLayers: true,
    summaryLayer: (leaf, asked) =>
      // A stretch view (db/knowers.ts) only where a separate join is on the path; elsewhere the shared layer.
      Effect.gen(function* () {
        // A private summary's continuity belongs to the planning fork, including when its
        // material and preceding layer end before J. The prefix must never fall back to the
        // shared chain of the destination's missed messages.
        const privateChunk = isStretchView(asked) && settings.summaryBefore !== undefined
        const applies = privateChunk || !isStretchView(asked) || (yield* stretchOnPath(sql, chatId, leaf))
        const identities = applies ? asked : undefined
        let view: LayerView | undefined = identities ? { identities } : undefined
        if (privateChunk && identities) {
          const forkId = yield* viewAt(sql, chatId, leaf)
          const [fork] = yield* sql<{ id: string; tip_slot_id: string | null }>`
            SELECT id, tip_slot_id FROM forks WHERE id = ${forkId} AND chat_id = ${chatId}`
          const end = fork ? yield* displayEndOf(sql, chatId, fork) : null
          view = {
            identities,
            unknownFrom: end === null ? null : yield* firstUnknownPosition(sql, chatId, end, identities)
          }
        }
        return yield* selectSummaryLayer(
          sql,
          userId,
          chatId,
          settings.summaryBefore ? settings.summaryBefore.slot : leaf,
          settings.partialBatch,
          view,
          true
        ).pipe(
          Effect.map((layer) =>
            settings.condense
              ? {
                  summaries: [...layer.summaries, ...settings.condense.children],
                  cursor: settings.condense.cursor,
                  cursorDepth: settings.condense.cursorDepth
                }
              : settings.summaryBefore
                ? { ...layer, cursor: settings.summaryBefore.slot, cursorDepth: settings.summaryBefore.depth }
                : layer
          ),
          Effect.flatMap((layer) =>
            selectFailedRanges(
              sql,
              userId,
              chatId,
              settings.summaryBefore ? settings.summaryBefore.slot : leaf,
              layer.cursorDepth,
              identities ? audienceKey(identities) : null
            ).pipe(Effect.map((failures) => ({ ...layer, failures })))
          ),
          // The layer's cursor is a display position already (selectSummaryLayer in a fork that
          // shows insertions, spec/MESSAGE-INSERT.md §3.4), which the history's positions compare with.
          Effect.tap((layer) =>
            Effect.sync(() => {
              layerPins = {
                failures: layer.failures,
                cursor: layer.cursor,
                cursorDepth: layer.cursorDepth,
                summaries: layer.summaries.map((s) => ({
                  id: s.id,
                  revision: s.revisionId,
                  fresh: s.fresh,
                  status: s.status
                }))
              }
            })
          )
        )
      }),
    target: "next" in settings ? nextTarget : versionTarget(settings.slotId, settings.versionId),

    historyStart: (leaf) =>
      Effect.map(
        Effect.flatMap(display(leaf), (shown) => previousStartIn(sql, userId, chatId, leaf, shown)),
        (row) => {
          pins.historyStart = row
            ? {
                slotId: row.slot_id,
                depth: row.depth,
                ...(row.state_json
                  ? {
                      state: withHistoryCheckpoint(
                        JSON.parse(row.state_json),
                        row.checkpoint_sent ? JSON.parse(row.checkpoint_sent) : undefined
                      )
                    }
                  : {})
              }
            : null
          return pins.historyStart
        }
      ),

    historyRevision: (leaf, before) =>
      Effect.suspend(() => {
        const key = keyOf(leaf, before)
        const cached = pins.historyRevisions[key]
        return cached === undefined
          ? Effect.flatMap(viewAt(sql, chatId, leaf), (fork) =>
              Effect.flatMap(display(leaf), (shown) =>
                shown === null || fork === null
                  ? historyRevision(sql, userId, chatId, leaf, before, fork)
                  : displayHistoryRevision(sql, userId, chatId, shown.pieces, before, fork)
              )
            ).pipe(
              Effect.map(([row]) => {
                const revision = row!.revision
                pins.historyRevisions[key] = revision
                return revision
              })
            )
          : Effect.succeed(cached)
      }),

    // The events at `at` (StateEventsAt's query), with the depth of the message each follows.
    events: (at) =>
      Effect.gen(function* () {
        const applies = yield* attached(at, "s", "e.version_id")
        const eventFork = yield* viewAt(sql, chatId, at)
        const shown = yield* display(at)
        const rows = yield* sql<{
          id: string
          key: string
          scope: string | null
          value_json: string
          version_id: string | null
          origin: string
          origin_ref: string | null
          depth: number | null
        }>`
          ${shown === null ? pathEvents(sql, chatId, at) : displayEvents(sql, chatId, shown.pieces)}
          SELECT e.id, e.key, e.scope, e.value_json, e.version_id, e.origin, e.origin_ref,
            ${sql.literal(shown === null ? "e.slot_depth" : "e.position")} AS depth
          FROM path_events e LEFT JOIN slots s ON s.id = e.slot_id
          WHERE ${owned} AND ${eventApplies(sql, eventFork, "e")}
            AND (e.slot_id IS NULL OR NOT ${slotDeletedIn(sql, eventFork, "s")})
            AND ${applies}
          ORDER BY ${sql.literal(shown === null ? eventOrder("e") : eventOrder("e", "e.position"))}`
        const applicable = yield* withoutOrphanNoteActivations(sql, rows)
        const events = yield* Effect.forEach(applicable, (row) =>
          decodeEvent({ scope: row.scope, data: { key: row.key, value: JSON.parse(row.value_json) } }).pipe(
            Effect.map((event) => ({ ...event, depth: row.depth, id: row.id })),
            Effect.mapError(() => invalid("A state event"))
          )
        )
        const kept = (yield* withoutPurged(sql, events)) as typeof events
        pins.events = kept.map(({ id, depth }) => ({ id, depth }))
        return kept.map(({ scope, data, depth }): PositionedEvent => ({ depth, event: { scope, data } }))
      }),

    history: (leaf, limit, after) =>
      Effect.gen(function* () {
        const selected = yield* shown(leaf, "s")
        const fork = yield* viewAt(sql, chatId, leaf)
        const onDisplay = yield* display(leaf)
        // By position on the display path: the last `limit` up to the leaf, after `after`.
        const window =
          onDisplay === null
            ? null
            : yield* Effect.gen(function* () {
                const from = after == null ? null : yield* positionIn(onDisplay.pieces, after)
                const first = Math.max(from === null ? 0 : from + 1, onDisplay.end - limit + 1)
                return {
                  first,
                  floor: from === null ? 0 : from + 1
                }
              })
        const workshopTranscript = settings.workshopHistory
          ? sql`(SELECT p.transcript_json FROM rollout_payloads p JOIN rollouts r ON r.id = p.rollout_id
              WHERE p.rollout_id = v.rollout_id AND r.status NOT IN ('created', 'running')
                AND json_extract(p.context_snapshot_json, '$.agentAssembly.workshop') = 1)`
          : sql`NULL`
        const columns = sql`${workshopTranscript} AS workshop_transcript, s.id AS slot_id, s.parent_slot_id, ${sql.literal(window === null ? "s.depth" : "path.position AS depth, s.inserted")}, ${contextExcludedIn(sql, fork)} AS context_excluded,
            ${slotDeletedIn(sql, fork, "s")} AS slot_deleted, v.id AS version_id, o.ordinal, v.status,
            (SELECT count(*) FROM versions c WHERE c.slot_id=s.id AND c.fork_id IS NULL
              AND c.ordinal <= o.ordinal AND NOT ${versionDeletedIn(sql, fork, "c")}) AS version_number,
            v.speaker_entity_id, v.content, v.reply_sections, v.macro_mode, v.frozen_macros, v.created_at,
            ${thinkingHiddenIn(sql, fork, "o.id")} AS hidden_thinking,
            (SELECT json_group_array(CASE WHEN ${imageExcludedIn(sql, fork, "o.id", "a.media_id")}
                THEN json_object('mediaId', a.media_id, 'sha256', a.sha256, 'width', a.width, 'height', a.height, 'excluded', json('true'))
                ELSE json_object('mediaId', a.media_id, 'sha256', a.sha256, 'width', a.width, 'height', a.height) END) FROM
              (SELECT va.media_id, m.sha256, m.width, m.height FROM version_attachments va
                JOIN media_assets m ON m.id = va.media_id WHERE va.version_id=v.id AND va.kind <> 'file' ORDER BY va.ordinal) a) AS images_json,
            (SELECT json_group_array(json_object('mediaId', a.media_id, 'name', a.name, 'path', a.path, 'mime', a.mime, 'size', a.byte_size,
                'card', json((SELECT json_object('name', c.name, 'format', c.format, 'spec', c.spec, 'specVersion', c.spec_version,
                  'doc', json(c.doc_json)) FROM media_card_files c WHERE c.media_id = a.media_id)),
                'image', json(CASE WHEN a.kind = 'file' THEN 'false' ELSE 'true' END),
                'excluded', json(CASE WHEN a.kind <> 'file' AND ${imageExcludedIn(sql, fork, "o.id", "a.media_id")} THEN 'true' ELSE 'false' END))) FROM
              (SELECT va.media_id, va.kind, va.name, va.path, m.mime, m.byte_size FROM version_attachments va
                JOIN media_assets m ON m.id = va.media_id WHERE va.version_id=v.id AND va.path IS NOT NULL ORDER BY va.ordinal) a) AS attachments_json,
            ${libraryDocuments(sql)} AS library_json,
            (SELECT count(*) FROM versions c WHERE c.slot_id = s.id AND c.fork_id IS NULL
              AND NOT ${versionDeletedIn(sql, fork, "c")}) AS version_count,
            f.writer AS first_writer, f.origin AS first_origin,
            (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) AS amend_count,
            v.macro_mode = 'template' AND EXISTS (SELECT 1 FROM state_events w WHERE w.version_id = v.id
              AND w.key = 'var.set' AND w.origin = 'rollout') AS written,
            (SELECT json_object('id', m.id, 'title', m.title, 'framing', m.framing, 'start', m.start_slot_id,
                'timelines', m.timelines,
                'cast', (SELECT json_group_array(c.value ->> 'name') FROM json_each(m.cast_json) c
                  WHERE c.value ->> 'from' <> 'destination'))
              FROM chat_merges m WHERE m.slot_id = s.id) AS merge_json`
        const joins = sql`JOIN version_records v ON v.id = ${selected}
          JOIN versions o ON o.id = ${sql.literal(originalSql("v"))}
          JOIN versions f ON f.id = (SELECT id FROM versions x WHERE x.slot_id = s.id ORDER BY x.ordinal LIMIT 1)`
        const rows =
          window === null
            ? yield* sql<HistoryRow>`
          WITH RECURSIVE path(id, n) AS (
            SELECT id, 1 FROM slots WHERE id = ${leaf} AND id IS NOT ${after ?? null} AND chat_id = ${chatId} AND ${owned}
            UNION ALL
            SELECT s.parent_slot_id, p.n + 1 FROM slots s JOIN path p ON s.id = p.id
            WHERE s.parent_slot_id IS NOT NULL AND s.parent_slot_id IS NOT ${after ?? null} AND p.n < ${limit}
          )
          SELECT ${columns}
          FROM path JOIN slots s ON s.id = path.id ${joins}
          ORDER BY s.depth`
            : window.first > onDisplay!.end
              ? []
              : yield* sql<HistoryRow>`
          ${displaySlots(sql, onDisplay!.pieces, window.first, onDisplay!.end)}
          SELECT ${columns}
          FROM display_slots path JOIN slots s ON s.id = path.id ${joins}
          WHERE ${owned}
          ORDER BY path.position`
        const read = rows
          .filter((row) => row.slot_deleted === 0)
          .map((row): HistoryEntry & { amends: number } => ({
            slotId: row.slot_id,
            versionId: row.version_id,
            depth: row.depth,
            ...(row.inserted === 1 ? { inserted: true as const } : {}),
            speaker: row.speaker_entity_id,
            side: row.first_writer === "human" && row.first_origin !== "greeting" ? "user" : "assistant",
            content: row.content,
            ...(row.workshop_transcript
              ? {
                  workshopHistory: workshopHistory(
                    JSON.parse(row.workshop_transcript) as Array<AgentMessage>,
                    row.version_id
                  ),
                  ...(row.amend_count > 0 ? { workshopEdited: true as const } : {})
                }
              : {}),
            ...sectionsOf(row.reply_sections),
            ...(row.hidden_thinking ? { thinkingHidden: hiddenParts(row.hidden_thinking) } : {}),
            ...(row.images_json !== "[]" ? { images: JSON.parse(row.images_json) } : {}),
            ...(row.attachments_json !== "[]" ? { attachments: JSON.parse(row.attachments_json) } : {}),
            ...(row.library_json !== "[]" ? { library: JSON.parse(row.library_json) } : {}),
            macroMode: row.macro_mode,
            frozen: row.frozen_macros === null ? null : (JSON.parse(row.frozen_macros) as Record<string, string>),
            written: row.written === 1,
            inContext:
              row.context_excluded === 0 &&
              (row.status !== "failed" || row.workshop_transcript !== null) &&
              (row.content.length > 0 ||
                row.workshop_transcript !== null ||
                row.images_json !== "[]" ||
                row.attachments_json !== "[]" ||
                row.library_json !== "[]"),
            sentAt: row.created_at,
            versions: row.version_count,
            selectedOrdinal: row.ordinal,
            versionNumber: row.version_number,
            ...(row.merge_json ? { merge: historyMerge(row.merge_json) } : {}),
            amends: row.amend_count
          }))
        const older =
          window === null
            ? rows[0]?.parent_slot_id === after
              ? null
              : (rows[0]?.parent_slot_id ?? null)
            : window.first > window.floor
              ? yield* slotAtPosition(sql, onDisplay!.pieces, window.first - 1)
              : null
        pins.history.push({
          key: keyOf(leaf, limit, after ?? null),
          older,
          entries: read.map(({ content: _, replySections: _sections, library, ...pinned }) => ({
            ...pinned,
            ...(library ? { library: library.map(({ doc: _, ...item }) => item) } : {})
          }))
        })
        return { entries: read.map(({ amends: _, ...entry }) => entry), older }
      }),

    cards: (entities, bindings) =>
      Effect.map(
        Effect.forEach(entities, (entity) => card(entity, bindings[entity])),
        (read) => {
          const cards = read.filter((c): c is CardInput => c !== null)
          pins.cards.push({
            key: keyOf(entities, bindings),
            found: cards.map(({ entity, ref, revision }) => ({ entity, ref, revision }))
          })
          return cards
        }
      ),

    globalRegex: Effect.map(readGlobalRegex(sql, userId), ({ scripts }) => {
      pins.globalRegex = [...scripts]
      return scripts
    }),

    lorebooks: (refs) =>
      Effect.gen(function* () {
        const read = yield* Effect.forEach(refs, (id) =>
          Effect.gen(function* () {
            const row = yield* refHead(id, "lorebook")
            if (!row) return []
            const doc = yield* decoded<LorebookDoc>(decodeLorebook(JSON.parse(row.doc_json)), "A lorebook")
            const sourceName = bookSourceName(row.source_path)
            return [
              { id, entity: row.entity_id, revision: row.head_revision_id, doc, sourceName } satisfies LorebookInput
            ]
          })
        )
        const books = read.flat()
        pins.lorebooks.push({
          key: keyOf(refs),
          found: books.map(({ id, entity, revision, sourceName }) => ({ id, entity, revision, sourceName }))
        })
        return books
      }),

    notes: (cards, bound) =>
      Effect.gen(function* () {
        // The cards' notes and the chat's own.
        const rows = yield* sql<{ entity: string; revision: string; doc_json: string; card: string | null }>`
          SELECT e.id AS entity, r.head_revision_id AS revision, h.doc_json,
            json_extract(h.doc_json, '$.owner.card') AS card
          FROM entities e JOIN entity_refs r ON r.entity_id = e.id
          JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
            AND (json_extract(h.doc_json, '$.owner.chat') = ${chatId}
              OR json_extract(h.doc_json, '$.owner.card') IN ${sql.in(cards.length === 0 ? [""] : cards)})
          ORDER BY e.id`
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const pinned = bound[row.entity]
            const json = pinned ? (yield* revisionDoc(pinned, "note", row.entity))?.doc_json : row.doc_json
            if (json === undefined) return []
            const doc = yield* decoded<NoteDoc>(decodeNote(JSON.parse(json)), "A note")
            const card = noteCard(doc)
            if (card === null ? "chat" in doc.owner && doc.owner.chat !== chatId : !cards.includes(card)) return []
            const linked = doc.link === undefined ? null : yield* sharedHead(doc.link)
            const note: NoteInput = {
              entity: row.entity,
              revision: pinned ?? row.revision,
              doc: linked?.doc ? { ...doc, content: linked.doc.content } : doc,
              ...(linked ? { link: { entity: linked.entity, revision: linked.revision } } : {})
            }
            return [note]
          })
        ).pipe(
          Effect.map((lists) => {
            const notes = lists.flat()
            pins.notes.push({
              key: keyOf(cards, bound),
              found: notes.map(({ entity, revision, link }) => ({
                entity,
                revision,
                ...(link ? { link } : {})
              }))
            })
            return notes
          })
        )
      }),

    noteHistory: (entity, revision, limit) =>
      history
        .noteHistory(entity, revision, limit)
        .pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              Effect.map(decoded<NoteDoc>(decodeNote(row.doc), "A note"), (doc) => ({ revision: row.revision, doc }))
            )
          )
        ),
    onPath: history.onPath,

    loreState: (leaf, identities, continuing) =>
      Effect.gen(function* () {
        const selected = yield* shown(leaf, "s")
        const fork = yield* viewAt(sql, chatId, leaf)
        const onDisplay = yield* display(leaf)
        const path =
          onDisplay === null
            ? sql`WITH RECURSIVE path(id, position) AS (
              SELECT id, depth FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND ${owned}
              UNION ALL
              SELECT s.parent_slot_id, p.position - 1 FROM slots s JOIN path p ON s.id = p.id
              WHERE s.parent_slot_id IS NOT NULL
            )`
            : sql`${displaySlots(sql, onDisplay.pieces, 0, onDisplay.end)}, path AS (SELECT id, position FROM display_slots)`
        // Continue and edits retain the admissions of their source versions. Swipes have no source.
        const receipts = (version: Fragment) => sql`(
          WITH RECURSIVE lineage(id, source, n) AS (
            SELECT id, source_version_id, 0 FROM versions WHERE id = ${version}
            UNION ALL
            SELECT v.id, v.source_version_id, l.n + 1 FROM versions v JOIN lineage l ON v.id = l.source
          )
          SELECT json_group_array(json_object('id', v.id, 'offset', a.message_offset, 'entries', json(a.entries_json)))
          FROM (SELECT id FROM lineage ORDER BY n DESC) l JOIN versions v ON v.id = l.id
          JOIN lore_activations a ON a.rollout_id = v.rollout_id
        )`
        // One path scan for every timed entry. Compact receipts avoid reading context payloads.
        const rows = [
          ...(yield* sql<{ eligible: number; receipts: string }>`
          ${path}
          SELECT CASE WHEN ${contextExcludedIn(sql, fork)} = 0 AND v.status <> 'failed'
            AND ${hasVersionPayload(sql)} THEN 1 ELSE 0 END AS eligible, ${receipts(sql`v.id`)} AS receipts
          FROM path JOIN slots s ON s.id = path.id JOIN versions v ON v.id = ${selected}
          WHERE NOT ${slotDeletedIn(sql, fork, "s")} AND ${owned} ORDER BY path.position`)
        ]
        if (continuing) {
          const continued = yield* sql<{ eligible: number; receipts: string }>`
            SELECT 1 AS eligible, ${receipts(sql`v.id`)} AS receipts FROM versions v JOIN slots s ON s.id = v.slot_id
            WHERE v.id = ${continuing} AND s.chat_id = ${chatId} AND v.content_length > 0 AND ${owned}`
          rows.push(...continued)
        }
        const relevant = new Set(identities)
        let count = 0
        const activations: Array<LoreTimeline["activations"][number]> = []
        for (const row of rows) {
          if (row.eligible) {
            const recorded = JSON.parse(row.receipts) as Array<{
              id: string
              offset: number
              entries: Array<LoreReceipt>
            }>
            for (const receipt of recorded)
              activations.push({
                id: receipt.id,
                at: count + receipt.offset,
                entries: receipt.entries.filter((entry) => relevant.has(entry.key))
              })
            count++
          }
        }
        const state = {
          count,
          effects: [...loreEffectsAt({ count, activations })].map(([key, effect]) => ({ key, ...effect }))
        }
        pins.loreStates.push({ key: keyOf(leaf, identities, continuing ?? null), state })
        return state
      }),

    messageCount: (leaf) =>
      Effect.gen(function* () {
        const selected = yield* shown(leaf, "s")
        const fork = yield* viewAt(sql, chatId, leaf)
        const onDisplay = yield* display(leaf)
        const counted = sql`count(*) AS n FROM path JOIN slots s ON s.id = path.id
        JOIN versions v ON v.id = ${selected}
        WHERE NOT ${slotDeletedIn(sql, fork, "s")} AND ${contextExcludedIn(sql, fork)} = 0 AND v.status <> 'failed' AND ${hasVersionPayload(sql)}`
        const [row] =
          onDisplay === null
            ? yield* sql<{ n: number }>`
        WITH RECURSIVE path(id) AS (
          SELECT id FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND ${owned}
          UNION ALL
          SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL
        )
        SELECT ${counted}`
            : yield* sql<{ n: number }>`
        ${displaySlots(sql, onDisplay.pieces, 0, onDisplay.end)}
        , path AS (SELECT id FROM display_slots)
        SELECT ${counted} AND ${owned}`
        const count = row?.n ?? 0
        pins.messageCount.push({ key: keyOf(leaf), count })
        return count
      }),

    stretches: (leaf, viewers) =>
      Effect.gen(function* () {
        const ranges = yield* threadStretches(sql, yield* viewAt(sql, chatId, leaf ?? null), leaf, viewers)
        if (ranges.length) stretchPins = ranges
        return ranges
      }),

    knowers: (versionIds) =>
      Effect.gen(function* () {
        // In the fork read: what it counts each card not present for (spec/THREADS.md §5.2).
        const found = yield* readKnowers(
          sql,
          chatId,
          owned,
          versionIds,
          null,
          yield* viewAt(sql, chatId, null),
          stretchPins ?? []
        )
        knowerPins.push({ key: keyOf(versionIds), found })
        return found
      }),

    // Frozen rows (`chat_merge_messages_frozen`): a rebuild reads them again, unpinned.
    mergeRows: (mergeIds) => readMergeRows(sql, chatId, owned, mergeIds),

    // A reply's reasoning and what the provider sent never change once it's written: unpinned.
    nativeReasoning: (versionIds) =>
      versionIds.length === 0
        ? Effect.succeed([])
        : sql<{ version_id: string; reasoning: number; native: string | null }>`
            SELECT v.id AS version_id, coalesce(t.reasoning, '') <> '' AS reasoning, t.native_reasoning AS native
            FROM versions v JOIN version_texts t ON t.version_seq = v.seq JOIN slots s ON s.id = v.slot_id
            WHERE s.chat_id = ${chatId} AND ${owned} AND v.id IN ${sql.in(versionIds)}`.pipe(
            Effect.map((rows) =>
              rows.map((row) => ({ versionId: row.version_id, reasoning: row.reasoning === 1, native: row.native }))
            )
          ),

    knewThrough: (leaf, viewer, through, aliases) =>
      Effect.gen(function* () {
        const selected = yield* shown(leaf, "s")
        const fork = yield* viewAt(sql, chatId, leaf)
        const onDisplay = yield* display(leaf)
        // A message the viewer doesn't know: its version's cast less those away, and its speaker;
        // a merge's join, its source's cast; nothing recorded, everyone.
        const unknown = sql`EXISTS (SELECT 1 FROM path JOIN slots s ON s.id = path.id
          JOIN version_records v ON v.id = ${selected}
          WHERE NOT ${slotDeletedIn(sql, fork, "s")} AND ${contextExcludedIn(sql, fork)} = 0 AND v.status <> 'failed'
            AND NOT ${yield* knowsSql(sql, aliases ?? [viewer], fork)}) AS unknown`
        const [row] =
          onDisplay === null
            ? yield* sql<{ unknown: number }>`
        WITH RECURSIVE walk(id, depth) AS (
          SELECT id, depth FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND ${owned}
          UNION ALL
          SELECT s.parent_slot_id, w.depth - 1 FROM slots s JOIN walk w ON s.id = w.id WHERE s.parent_slot_id IS NOT NULL
        ), path AS (SELECT id FROM walk WHERE depth <= ${through})
        SELECT ${unknown}`
            : yield* sql<{ unknown: number }>`
        ${displaySlots(sql, onDisplay.pieces, 0, Math.min(through, onDisplay.end))}
        , path AS (SELECT id FROM display_slots)
        SELECT ${unknown} WHERE ${owned}`
        const knew = (row?.unknown ?? 0) === 0
        knewPins.push({ key: keyOf(leaf, viewer, through, ...(aliases ? [aliases] : [])), knew })
        return knew
      }),

    model: (binding) =>
      Effect.gen(function* () {
        const chosen = settings.modelOverride ?? binding ?? (yield* defaults).model
        if (!settings.modelOverride)
          chosenModel = chosen === null ? null : { ...chosen, scope: binding ? "chat" : "user" }
        if (chosen === null) return null
        const [connection] = yield* sql<ConnectionRow>`
          SELECT ${sql.literal(connectionColumns)} FROM ${sql.literal(connectionFrom)}
          WHERE c.id = ${chosen.connection} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND c.purged_at IS NULL`
        const [model] = connection
          ? yield* sql<ModelRow>`SELECT * FROM models WHERE id = ${chosen.model} AND connection_id = ${connection.id}`
          : []
        // A binding to a connection or model that's gone fails visibly; it never falls back.
        if (!connection || !model) {
          return yield* new AssemblyFailed({
            reason: "no_model",
            message: "The model this chat is bound to is gone: its connection or the model was deleted. Choose another."
          })
        }
        const c = toConnection(connection)
        const m = toModel(model)
        const providers = yield* CurrentProviderDefinitions
        const provider = findProvider(providers, c.provider, c.kind, c.baseUrl)
        const cacheContract = provider ? provider.cacheContract : c.kind
        const providerSettings = resolveProviderSettings(provider, c.providerSettings)
        const effective = resolveModel(m.key, m.upstream, m.overrides, c.compat, providerSettings, {
          ...c,
          provider: provider?.id ?? c.provider
        })
        resolvedModel = {
          openRouterResponses: c.api === "openai-responses" && isOpenRouterEndpoint(c.baseUrl),
          ...(provider ? { provider: provider.id } : {}),
          connectionId: c.id,
          connectionRevision: connection.cache_revision,
          mapping: mappingCapabilities(effective),
          settings: effective.settings,
          cacheTtlOverride: effective.cacheTtlS.source === "user" || c.cacheTtlS !== null,
          cacheTtlS:
            effective.cacheTtlS.source === "user"
              ? effective.cacheTtlS.value
              : (c.cacheTtlS ??
                effective.cacheTtlS.value ??
                (cacheContract === null
                  ? null
                  : documentedCachePolicy({ provider: cacheContract, api: c.api, model: m.key })?.ttlS) ??
                null),
          cacheContract,
          modelId: m.id,
          kind: c.kind,
          api: c.api,
          key: m.key,
          ...(effective.catalog ? { catalogKey: effective.catalog.match } : {}),
          prefill: effective.prefill.value,
          continueUnavailable: prefillUnavailable(
            { kind: c.kind, api: c.api, key: m.key, prefill: effective.prefill.value },
            c.baseUrl,
            { ...(m.upstream.fixed ? { fixed: m.upstream.fixed } : {}), route: effective.route }
          ),
          ...(providerSettings.toolLoading ? { toolLoading: providerSettings.toolLoading } : {}),
          cacheBreakpoints: effective.cacheBreakpoints.value,
          cacheLayout: effective.cacheLayout.value,
          vision: effective.vision.value,
          maxImages: effective.maxImages.value,
          context: effective.context.source === "unknown" ? null : effective.context.value,
          contextSource: effective.context.source,
          ...(effective.context.source === "catalog" && effective.catalog
            ? { contextCatalog: `${effective.catalog.label} (${effective.catalog.match})` }
            : {}),
          maxOutput: effective.maxOutput.source === "unknown" ? null : effective.maxOutput.value,
          presetOverride: c.presetOverrideRefId
        }
        return resolvedModel
      }),

    // The scope chain (DATA-MODEL §5.4): the chat's role binding, the chat's own, the
    // connection's override, the user's default, the instance's, then ST's default. A level
    // that names something deleted is passed over.
    imageTokenFacts: (model, sha256s) =>
      readImageTokenFacts(sql, userId, model, sha256s).pipe(
        Effect.map((facts) => {
          pins.imageTokenFacts = facts
          return facts
        })
      ),
    lcmDefaults: () =>
      Effect.map(defaults, (read) => {
        pins.lcmDefaults = read.lcm ?? null
        return pins.lcmDefaults
      }),
    preset: (chain) =>
      Effect.gen(function* () {
        // Unlike the current account preset, a summary's specific choice must be live.
        if (chain.summary) {
          const [available] =
            yield* sql`SELECT r.id FROM entity_refs r JOIN entities e ON e.id=r.entity_id WHERE r.id=${chain.summary}
            AND e.owner_user_id=${userId} AND e.kind='preset' AND e.deleted_at IS NULL AND e.archived_at IS NULL`
          if (available) {
            const found = yield* presetFrom(chain.summary, "user")
            if (found)
              return {
                ...found,
                doc: withModelSettings(
                  found.doc,
                  resolvedModel?.settings ?? {},
                  resolvedModel?.context,
                  resolvedModel?.maxOutput
                )
              }
          }
        }
        const user = chain.chat ? (chain.chat.ref ?? null) : (yield* defaults).preset
        if (user !== null) {
          const found = yield* presetFrom(user, chain.chat ? "chat" : "user")
          if (found)
            return {
              ...found,
              doc: withModelSettings(
                found.doc,
                resolvedModel?.settings ?? {},
                resolvedModel?.context,
                resolvedModel?.maxOutput
              )
            }
        }
        return {
          ref: null,
          revision: null,
          scope: "builtin",
          doc: withModelSettings(
            builtinPreset,
            resolvedModel?.settings ?? {},
            resolvedModel?.context,
            resolvedModel?.maxOutput
          )
        } satisfies PresetInput
      })
  })

  const sources = replay
    ? replaySources(
        sql,
        { userId, chatId },
        replay,
        (revision, kind, entity) =>
          // A revision never changes: one of an entity in the bin still reads as it was.
          revisionDoc(revision, kind, entity, true),
        live
      )
    : live
  return {
    layer: Layer.succeed(AssemblySources)(sources),
    /** The sources themselves, for a source that stands in for some of them (`draftSources.ts`). */
    service: sources,
    /** What the sources read; a replay's are the pins it was given. */
    pins: (): SourcePins =>
      replay?.pins ?? {
        ...pins,
        target: pins.target!,
        ...(layerPins ? { lcm: layerPins } : {}),
        ...(stretchPins ? { stretches: stretchPins } : {}),
        ...(knowerPins.length ? { knowers: knowerPins } : {}),
        ...(knewPins.length ? { knewThrough: knewPins } : {})
      },
    /** Capabilities survive later assembly failures, including budget rejection. */
    resolvedModel: () => resolvedModel,
    /** The model chosen and where from, also when it's gone and the assembly failed on it. */
    chosenModel: () => chosenModel
  }
}

/** A model choice and the level it comes from: the chat's binding or the user's default. */
interface ChosenModel {
  readonly connection: string
  readonly model: string
  readonly scope: "chat" | "user"
}

/** The sources a replay reads: what the pins name, as it was then. */
const replaySources = (
  sql: SqlClient.SqlClient,
  { userId, chatId }: { readonly userId: UserId; readonly chatId: ChatId },
  { pins, inputs }: Replay,
  revisionDoc: (
    revisionId: string,
    kind: string,
    entity?: string
  ) => Effect.Effect<{ entity_id: string; doc_json: string } | undefined, SqlError.SqlError>,
  live: AssemblySources["Service"]
): AssemblySources["Service"] => {
  const owned = sql`EXISTS (SELECT 1 FROM chats o WHERE o.id = ${chatId} AND o.owner_user_id = ${userId})`
  const pinned = <A extends { readonly key: string }>(list: ReadonlyArray<A>, key: string, what: string) => {
    const found = list.find((p) => p.key === key)
    return found ? Effect.succeed(found) : Effect.fail(unpinned(what))
  }
  return {
    viewLayers: true,
    ...(pins.stretches ? { stretches: () => Effect.succeed(pins.stretches!) } : {}),
    summaryLayer: () =>
      Effect.gen(function* () {
        const layer = pins.lcm
        if (!layer) return yield* unpinned("the summary layer")
        const summaries = yield* Effect.forEach(layer.summaries, (pin) =>
          readSummary(sql, userId, pin.id, pin.revision).pipe(
            Effect.flatMap((summary) =>
              summary.chatId === chatId
                ? Effect.succeed({ ...summary, fresh: pin.fresh, status: pin.status })
                : Effect.fail(new NotFound({ entity: "summary", id: pin.id }))
            )
          )
        )
        return { summaries, failures: layer.failures ?? [], cursor: layer.cursor, cursorDepth: layer.cursorDepth }
      }),
    target: sql<{ ok: number }>`SELECT ${owned} AS ok`.pipe(
      Effect.flatMap(([row]) =>
        row?.ok ? Effect.succeed(pins.target) : Effect.fail(new NotFound({ entity: "chat", id: chatId }))
      )
    ),

    historyStart: () => Effect.succeed(pins.historyStart ?? null),
    lcmDefaults: () => Effect.succeed(pins.lcmDefaults ?? null),
    // A replay estimates images as the snapshot did; one from before this was pinned, by formula.
    imageTokenFacts: () => Effect.succeed(pins.imageTokenFacts ?? { counts: [], samples: [] }),
    historyRevision: (leaf, before) => Effect.succeed(pins.historyRevisions?.[keyOf(leaf, before)] ?? 0),

    events: () =>
      Effect.gen(function* () {
        const ids = pins.events.map((e) => e.id)
        const rows =
          ids.length === 0
            ? []
            : yield* sql<{ id: string; key: string; scope: string | null; value_json: string }>`
                SELECT e.id, e.key, e.scope, e.value_json FROM state_events e
                WHERE e.chat_id = ${chatId} AND ${owned} AND e.id IN ${sql.in(ids)}`
        const byId = new Map(rows.map((row) => [row.id, row]))
        return yield* Effect.forEach(pins.events, ({ id, depth }) => {
          const row = byId.get(id)
          if (!row) return Effect.fail(unpinned("a state event"))
          return decodeEvent({ scope: row.scope, data: { key: row.key, value: JSON.parse(row.value_json) } }).pipe(
            Effect.map((event): PositionedEvent => ({ depth, event })),
            Effect.mapError(() => invalid("A state event"))
          )
        })
      }),

    history: (leaf, limit, after) =>
      Effect.gen(function* () {
        const window = yield* pinned(pins.history, keyOf(leaf, limit, after ?? null), "part of the chat")
        const ids = window.entries.map((e) => e.versionId)
        const needsLibrary = window.entries.some((e) => e.library?.some((item) => item.doc === undefined))
        const rows =
          ids.length === 0
            ? []
            : yield* sql<{
                id: string
                content: string
                reply_sections: string | null
                amends: number
                library: string
              }>`
                SELECT v.id, v.content, v.reply_sections,
                  (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) AS amends,
                  ${needsLibrary ? libraryDocuments(sql) : sql`'[]'`} AS library
                FROM version_records v JOIN slots s ON s.id = v.slot_id
                WHERE s.chat_id = ${chatId} AND ${owned} AND v.id IN ${sql.in(ids)}`
        const byId = new Map(rows.map((row) => [row.id, row]))
        const entries = yield* Effect.forEach(window.entries, ({ amends, library, ...entry }) =>
          Effect.gen(function* () {
            const row = byId.get(entry.versionId)
            if (!row) return yield* unpinned("a message")
            const held = JSON.parse(row.library) as ReadonlyArray<HistoryLibraryItem>
            const documents: Array<HistoryLibraryItem> = []
            for (const item of library ?? []) {
              const doc =
                item.doc ??
                held.find((h) => h.refId === item.refId && h.revisionId === item.revisionId && h.kind === item.kind)
                  ?.doc
              if (!doc) return yield* unpinned("a message's library attachment")
              documents.push({ ...item, doc })
            }
            const attachments = library ? { library: documents } : {}
            // A reply's sections are the model's, frozen with it; an amend changes only the text.
            const sections = sectionsOf(row.reply_sections)
            if (row.amends === amends)
              return { ...entry, content: row.content, ...sections, ...attachments } satisfies HistoryEntry
            // Amended since: its text then is what the next amend replaced.
            const [earlier] = yield* sql<{ content: string }>`
              SELECT content FROM version_history WHERE version_id = ${entry.versionId}
              ORDER BY id LIMIT 1 OFFSET ${amends}`
            if (!earlier) return yield* unpinned("a message's earlier text")
            return { ...entry, content: earlier.content, ...sections, ...attachments } satisfies HistoryEntry
          })
        )
        return { entries, older: window.older }
      }),

    cards: (entities, bindings) =>
      Effect.gen(function* () {
        const { found } = yield* pinned(pins.cards, keyOf(entities, bindings), "a card")
        return yield* Effect.forEach(found, ({ entity, ref, revision }) =>
          Effect.gen(function* () {
            const row = yield* revisionDoc(revision, "card", entity)
            if (!row) return yield* unpinned("a card")
            const doc = yield* decoded<CardDoc>(decodeCard(JSON.parse(row.doc_json)), "A card")
            return { entity, ref, revision, doc } satisfies CardInput
          })
        )
      }),

    globalRegex: Effect.succeed(pins.globalRegex ?? []),

    lorebooks: (refs) =>
      Effect.gen(function* () {
        const { found } = yield* pinned(pins.lorebooks ?? [], keyOf(refs), "a lorebook")
        return yield* Effect.forEach(found, ({ id, entity, revision, sourceName }) =>
          Effect.gen(function* () {
            const row = yield* revisionDoc(revision, "lorebook", entity)
            if (!row) return yield* unpinned("a lorebook")
            const doc = yield* decoded<LorebookDoc>(decodeLorebook(JSON.parse(row.doc_json)), "A lorebook")
            return { id, entity, revision, doc, sourceName: sourceName ?? null } satisfies LorebookInput
          })
        )
      }),

    notes: (cards, bound) =>
      Effect.gen(function* () {
        const { found } = yield* pinned(pins.notes, keyOf(cards, bound), "a note")
        return yield* Effect.forEach(found, ({ entity, revision, link }) =>
          Effect.gen(function* () {
            const row = yield* revisionDoc(revision, "note", entity)
            if (!row) return yield* unpinned("a note")
            const doc = yield* decoded<NoteDoc>(decodeNote(JSON.parse(row.doc_json)), "A note")
            if (!link) return { entity, revision, doc } satisfies NoteInput
            if (link.revision === null) return { entity, revision, doc, link } satisfies NoteInput
            const shared = yield* revisionDoc(link.revision, "note", link.entity)
            if (!shared) return yield* unpinned("a shared note")
            const content = (yield* decoded<NoteDoc>(decodeNote(JSON.parse(shared.doc_json)), "A shared note")).content
            return { entity, revision, doc: { ...doc, content }, link } satisfies NoteInput
          })
        )
      }),

    noteHistory: live.noteHistory,
    onPath: live.onPath,
    loreState: (leaf, identities, continuing) =>
      Effect.map(
        pinned(pins.loreStates ?? [], keyOf(leaf, identities, continuing ?? null), "lorebook activation history"),
        ({ state }) => state
      ),
    messageCount: (leaf) =>
      Effect.map(pinned(pins.messageCount ?? [], keyOf(leaf), "the path message count"), ({ count }) => count),
    knowers: (versionIds) =>
      Effect.map(pinned(pins.knowers ?? [], keyOf(versionIds), "who knew the messages"), ({ found }) => found),
    ...(live.mergeRows ? { mergeRows: live.mergeRows } : {}),
    ...(live.nativeReasoning ? { nativeReasoning: live.nativeReasoning } : {}),
    knewThrough: (leaf, viewer, through, aliases) =>
      Effect.map(
        pinned(
          pins.knewThrough ?? [],
          keyOf(leaf, viewer, through, ...(aliases ? [aliases] : [])),
          "who knew the summarized messages"
        ),
        ({ knew }) => knew
      ),

    model: () => Effect.succeed(inputs.model),

    preset: () =>
      Effect.gen(function* () {
        const { ref, revision, scope } = inputs.preset
        if (revision === null)
          return {
            ref,
            revision,
            scope,
            doc: withModelSettings(
              builtinPreset,
              inputs.model?.settings ?? {},
              inputs.model?.context,
              inputs.model?.maxOutput
            )
          } satisfies PresetInput
        const row = yield* revisionDoc(revision, "preset")
        if (!row) return yield* unpinned("the preset")
        const doc = yield* decoded<PresetDoc>(
          decodePreset({ ...builtinPreset, ...JSON.parse(row.doc_json) }),
          "The preset"
        )
        return {
          ref,
          revision,
          scope,
          doc: withModelSettings(
            withEndOfRequest(doc).doc,
            inputs.model?.settings ?? {},
            inputs.model?.context,
            inputs.model?.maxOutput
          )
        } satisfies PresetInput
      })
  }
}
