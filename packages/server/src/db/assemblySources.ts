import { withModelSettings } from "@rp/shared/modelSettings.ts"
import { contextExcluded } from "./lcmVisibility.ts"
import { selectSummaryLayer, selectFailedRanges } from "./lcmLayer.ts"
import { readSummary } from "./lcmReads.ts"
// The assembler's sources over the database, every read the acting user's, and the pins a
// rebuild reads again (ARCHITECTURE §15).
import { documentedCachePolicy } from "../providers/cachePolicy.ts"
import { prefillUnavailable } from "../assembler/prefill.ts"
import { mappingCapabilities } from "../providers/mapping.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import { CardDoc } from "@rp/shared/docs/card.ts"
import { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { NoteDoc } from "@rp/shared/docs/note.ts"
import { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import { withConditions } from "@rp/shared/presetConditions.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { resolveModel } from "@rp/shared/providers.ts"
import { FoldableEvent } from "@rp/shared/state.ts"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import { AssemblySources, type PositionedEvent } from "../assembler/pipeline.ts"
import {
  AssemblyFailed,
  type ModelInput,
  type CardInput,
  type HistoryEntry,
  type NoteInput,
  type LorebookInput,
  noteCard,
  type PresetInput,
  type SnapshotInputs,
  type SourcePins,
  type Target
} from "../assembler/types.ts"
import { importStPreset } from "../formats/preset.ts"
import {
  connectionColumns,
  connectionFrom,
  type ConnectionRow,
  type ModelRow,
  toConnection,
  toModel
} from "./providers.ts"
import type { GenerationDefaults } from "@rp/shared/generation.ts"
import { readDefaults } from "./generationSettings.ts"
import { historyRevision } from "./historyChanges.ts"
import { previousHistoryStart } from "./historyStart.ts"
import { noteHistory } from "./noteHistory.ts"
import { withoutPurged } from "./stateRefs.ts"

const decodeEvent = Schema.decodeUnknownEffect(FoldableEvent)
const decodeCard = Schema.decodeUnknownExit(CardDoc)
const decodeLorebook = Schema.decodeUnknownExit(LorebookDoc)
const decodeNote = Schema.decodeUnknownExit(NoteDoc)
const decodePreset = Schema.decodeUnknownExit(PresetDoc)

/** ST's default chat-completion preset: what generation uses when nothing chooses one. */
export const builtinPreset = importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!

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

interface HistoryRow {
  readonly slot_id: string
  readonly parent_slot_id: string | null
  readonly depth: number
  readonly context_excluded: number
  readonly slot_deleted: number
  readonly version_id: string
  readonly ordinal: number
  readonly status: string
  readonly speaker_entity_id: string | null
  readonly content: string
  readonly macro_mode: "template" | "verbatim"
  readonly frozen_macros: string | null
  readonly created_at: number
  readonly version_count: number
  readonly first_writer: string
  readonly first_origin: string
  readonly amend_count: number
  readonly written: number
}

/**
 * The version being generated, or `next`: a reply not yet asked for, at the end of the
 * requested path (active by default), the request the cache-warmth estimate compares (DESIGN §5.5).
 */
type Settings = {
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
  /** A revision of an entity of this kind the user owns and hasn't deleted. */
  const revisionDoc = (revisionId: string, kind: string, entity?: string, binned = false) =>
    sql<{ entity_id: string; doc_json: string }>`
      SELECT v.entity_id, v.doc_json FROM entity_revisions v JOIN entities e ON e.id = v.entity_id
      WHERE v.id = ${revisionId} AND e.owner_user_id = ${userId} AND e.kind = ${kind}
        AND (${binned ? 1 : 0} OR e.deleted_at IS NULL)
        AND (${entity ?? null} IS NULL OR e.id = ${entity ?? null})`.pipe(Effect.map(([row]) => row))

  /** A ref the user owns, of this chat if it's an override, with its head's document. */
  const refHead = (refId: string, kind: string, entity?: string) =>
    sql<{ id: string; entity_id: string; head_revision_id: string; doc_json: string; source_path: string | null }>`
      SELECT r.id, r.entity_id, r.head_revision_id, h.doc_json,
        coalesce(r.source_path, (SELECT u.source_path FROM entity_refs u WHERE u.entity_id = r.entity_id AND u.ref_kind = 'upstream')) AS source_path
      FROM entity_refs r
      JOIN entities e ON e.id = r.entity_id JOIN entity_revisions h ON h.id = r.head_revision_id
      WHERE r.id = ${refId} AND e.owner_user_id = ${userId} AND e.kind = ${kind} AND e.deleted_at IS NULL
        AND (r.chat_id IS NULL OR r.chat_id = ${chatId})
        AND (${entity ?? null} IS NULL OR e.id = ${entity ?? null})`.pipe(Effect.map(([row]) => row))

  /** The ref an entity follows in this chat when nothing binds it: its override here, else its upstream. */
  const defaultRef = (entity: string) =>
    sql<{ id: string }>`
      SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
      WHERE r.entity_id = ${entity} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL
        AND ((r.ref_kind = 'chat_override' AND r.chat_id = ${chatId}) OR r.ref_kind = 'upstream')
      ORDER BY r.ref_kind = 'chat_override' DESC LIMIT 1`.pipe(Effect.map(([row]) => row?.id ?? null))

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
      return { ref: row.ref, revision: row.revision, scope, doc: withConditions(doc).doc } satisfies PresetInput
    })

  let layerPins: SourcePins["lcm"]
  let resolvedModel: ModelInput | null = null
  /** The model the chat's binding or the user's default chose, read or not; unset before the model is read. */
  let chosenModel: ChosenModel | null | undefined
  const pins = {
    target: null as Target | null,
    historyStart: null as NonNullable<SourcePins["historyStart"]> | null,
    historyRevisions: {} as Record<string, number>,
    events: [] as Array<SourcePins["events"][number]>,
    history: [] as Array<SourcePins["history"][number]>,
    cards: [] as Array<SourcePins["cards"][number]>,
    lorebooks: [] as Array<NonNullable<SourcePins["lorebooks"]>[number]>,
    notes: [] as Array<SourcePins["notes"][number]>,
    messageCount: [] as Array<NonNullable<SourcePins["messageCount"]>[number]>,
    userMessages: [] as Array<NonNullable<SourcePins["userMessages"]>[number]>
  }

  const pinTarget = (target: Target) =>
    Effect.sync(() => {
      pins.target = target
    })

  const versionTarget = (slotId: string, versionId: string) =>
    sql<{
      depth: number
      parent_slot_id: string | null
      ordinal: number
      speaker_entity_id: string | null
      direction: string | null
      continues: string | null
      continued_text: string | null
    }>`
      SELECT s.depth, s.parent_slot_id, v.ordinal, v.speaker_entity_id, v.direction,
        -- A generated version with a source continues it (ContinueVersion); the source is
        -- a version of the same slot (graphIntegrity.ts), frozen once it was written.
        CASE WHEN v.writer = 'model' AND v.origin = 'generated' THEN v.source_version_id END AS continues,
        (SELECT x.content FROM versions x WHERE x.id = v.source_version_id AND x.slot_id = v.slot_id) AS continued_text
      FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
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
                : { continues: { version: row.continues, text: row.continued_text ?? "" } })
            })
          : Effect.fail(new NotFound({ entity: "version", id: versionId }))
      ),
      Effect.tap(pinTarget)
    )

  const viewedLeaf = "next" in settings ? (settings.cut ?? settings.leafSlotId ?? null) : null
  const nextTarget = sql<{ leaf: string | null; depth: number | null }>`
    SELECT s.id AS leaf, s.depth FROM chats c LEFT JOIN slots s
      ON s.id = coalesce(${viewedLeaf}, c.active_leaf_slot_id) AND s.chat_id = c.id
    WHERE c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
      AND (${viewedLeaf} IS NULL OR (s.id IS NOT NULL AND s.deleted_at IS NULL))`.pipe(
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
    Effect.tap(pinTarget)
  )

  const history = noteHistory(sql, userId, chatId)
  const live = AssemblySources.of({
    summaryLayer: (leaf) =>
      selectSummaryLayer(
        sql,
        userId,
        chatId,
        settings.summaryBefore ? settings.summaryBefore.slot : leaf,
        settings.partialBatch
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
            layer.cursorDepth
          ).pipe(Effect.map((failures) => ({ ...layer, failures })))
        ),
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
      ),
    target: "next" in settings ? nextTarget : versionTarget(settings.slotId, settings.versionId),

    historyStart: (leaf) =>
      Effect.map(previousHistoryStart(sql, userId, chatId, leaf), ([row]) => {
        pins.historyStart = row
          ? { slotId: row.slot_id, depth: row.depth, ...(row.state_json ? { state: JSON.parse(row.state_json) } : {}) }
          : null
        return pins.historyStart
      }),

    historyRevision: (leaf, before) =>
      Effect.suspend(() => {
        const key = keyOf(leaf, before)
        const cached = pins.historyRevisions[key]
        return cached === undefined
          ? Effect.map(historyRevision(sql, userId, chatId, leaf, before), ([row]) => {
              const revision = row!.revision
              pins.historyRevisions[key] = revision
              return revision
            })
          : Effect.succeed(cached)
      }),

    // The events at `at` (StateEventsAt's query), with the depth of the message each follows.
    events: (at) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string
          key: string
          scope: string | null
          value_json: string
          depth: number | null
        }>`
          WITH RECURSIVE path(id) AS (
            SELECT id FROM slots WHERE id = ${at} AND chat_id = ${chatId} AND ${owned}
            UNION ALL
            SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL
          )
          SELECT e.id, e.key, e.scope, e.value_json, s.depth
          FROM state_events e
          LEFT JOIN path p ON p.id = e.slot_id
          LEFT JOIN slots s ON s.id = p.id
          WHERE e.chat_id = ${chatId} AND ${owned} AND e.superseded_by_changeset IS NULL
            AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND s.deleted_at IS NULL))
            AND (e.version_id IS NULL OR e.version_id = s.selected_version_id)
          ORDER BY coalesce(s.depth, -1), e.seq`
        const events = yield* Effect.forEach(rows, (row) =>
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
        const rows = yield* sql<HistoryRow>`
          WITH RECURSIVE path(id, n) AS (
            SELECT id, 1 FROM slots WHERE id = ${leaf} AND id IS NOT ${after ?? null} AND chat_id = ${chatId} AND ${owned}
            UNION ALL
            SELECT s.parent_slot_id, p.n + 1 FROM slots s JOIN path p ON s.id = p.id
            WHERE s.parent_slot_id IS NOT NULL AND s.parent_slot_id IS NOT ${after ?? null} AND p.n < ${limit}
          )
          SELECT s.id AS slot_id, s.parent_slot_id, s.depth, ${sql.literal(contextExcluded())} AS context_excluded,
            s.deleted_at IS NOT NULL AS slot_deleted, v.id AS version_id, v.ordinal, v.status,
            v.speaker_entity_id, v.content, v.macro_mode, v.frozen_macros, v.created_at,
            (SELECT count(*) FROM versions c WHERE c.slot_id = s.id AND c.deleted_at IS NULL) AS version_count,
            f.writer AS first_writer, f.origin AS first_origin,
            (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) AS amend_count,
            v.macro_mode = 'template' AND EXISTS (SELECT 1 FROM state_events w WHERE w.version_id = v.id
              AND w.key = 'var.set' AND w.origin = 'rollout') AS written
          FROM path JOIN slots s ON s.id = path.id JOIN versions v ON v.id = s.selected_version_id
          JOIN versions f ON f.id = (SELECT id FROM versions x WHERE x.slot_id = s.id ORDER BY x.ordinal LIMIT 1)
          ORDER BY s.depth`
        const read = rows
          .filter((row) => row.slot_deleted === 0)
          .map((row): HistoryEntry & { amends: number } => ({
            slotId: row.slot_id,
            versionId: row.version_id,
            depth: row.depth,
            speaker: row.speaker_entity_id,
            side: row.first_writer === "human" && row.first_origin !== "greeting" ? "user" : "assistant",
            content: row.content,
            macroMode: row.macro_mode,
            frozen: row.frozen_macros === null ? null : (JSON.parse(row.frozen_macros) as Record<string, string>),
            written: row.written === 1,
            inContext: row.context_excluded === 0 && row.status !== "failed" && row.content.length > 0,
            sentAt: row.created_at,
            versions: row.version_count,
            selectedOrdinal: row.ordinal,
            amends: row.amend_count
          }))
        const older = rows[0]?.parent_slot_id === after ? null : (rows[0]?.parent_slot_id ?? null)
        pins.history.push({
          key: keyOf(leaf, limit, after ?? null),
          older,
          entries: read.map(({ content: _, ...pinned }) => pinned)
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

    lorebooks: (refs) =>
      Effect.gen(function* () {
        const read = yield* Effect.forEach(refs, (id) =>
          Effect.gen(function* () {
            const row = yield* refHead(id, "lorebook")
            if (!row) return []
            const doc = yield* decoded<LorebookDoc>(decodeLorebook(JSON.parse(row.doc_json)), "A lorebook")
            const sourceName =
              row.source_path
                ?.replaceAll("\\", "/")
                .split("/")
                .at(-1)
                ?.replace(/\.json$/i, "") ?? null
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
          FROM entities e JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
          JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
            AND (json_extract(h.doc_json, '$.owner.chat') = ${chatId}
              OR json_extract(h.doc_json, '$.owner.card') IN ${sql.in(cards.length === 0 ? [""] : cards)})
          ORDER BY e.id`
        const seen = new Set<string>()
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            // A chat's note is on only once the chat turned it on.
            const first = row.card !== null && !seen.has(row.card)
            if (row.card !== null) seen.add(row.card)
            const pinned = bound[row.entity]
            const json = pinned ? (yield* revisionDoc(pinned, "note", row.entity))?.doc_json : row.doc_json
            if (json === undefined) return []
            const doc = yield* decoded<NoteDoc>(decodeNote(JSON.parse(json)), "A note")
            const card = noteCard(doc)
            if (card === null ? "chat" in doc.owner && doc.owner.chat !== chatId : !cards.includes(card)) return []
            return [{ entity: row.entity, revision: pinned ?? row.revision, doc, first } satisfies NoteInput]
          })
        ).pipe(
          Effect.map((lists) => {
            const notes = lists.flat()
            pins.notes.push({
              key: keyOf(cards, bound),
              found: notes.map(({ entity, revision, first }) => ({ entity, revision, first }))
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

    messageCount: (leaf) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ n: number }>`
        WITH RECURSIVE path(id) AS (
          SELECT id FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND ${owned}
          UNION ALL
          SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL
        )
        SELECT count(*) AS n FROM path JOIN slots s ON s.id = path.id
        JOIN versions v ON v.id = s.selected_version_id
        WHERE s.deleted_at IS NULL AND ${sql.literal(contextExcluded())} = 0 AND v.status <> 'failed' AND length(v.content) > 0`
        const count = row?.n ?? 0
        pins.messageCount.push({ key: keyOf(leaf), count })
        return count
      }),

    // A message's side as the history reads it (`sideOf` in the stages): its speaker's, when
    // that's one of the cast, else its first version's writer.
    userMessages: (leaf, personas, characters) =>
      Effect.gen(function* () {
        if (leaf === null) {
          pins.userMessages.push({ key: keyOf(leaf, personas, characters), count: 0 })
          return 0
        }
        const [row] = yield* sql<{ n: number }>`
          WITH RECURSIVE path(id) AS (
            SELECT id FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND ${owned}
            UNION ALL
            SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL
          )
          SELECT count(*) AS n FROM path JOIN slots s ON s.id = path.id
          JOIN versions v ON v.id = s.selected_version_id
          JOIN versions f ON f.id = (SELECT id FROM versions x WHERE x.slot_id = s.id ORDER BY x.ordinal LIMIT 1)
          WHERE s.deleted_at IS NULL AND (v.speaker_entity_id IN (SELECT value FROM json_each(${JSON.stringify(personas)}))
            OR (coalesce(v.speaker_entity_id IN (SELECT value FROM json_each(${JSON.stringify(characters)})), 0) = 0
              AND f.writer = 'human' AND f.origin <> 'greeting'))`
        const count = row?.n ?? 0
        pins.userMessages.push({ key: keyOf(leaf, personas, characters), count })
        return count
      }),

    model: () =>
      Effect.gen(function* () {
        const chosen = settings.modelOverride ?? (yield* defaults).model
        if (!settings.modelOverride) chosenModel = chosen === null ? null : { ...chosen, scope: "user" }
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
        const effective = resolveModel(m.key, m.upstream, m.overrides, c.compat)
        resolvedModel = {
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
                documentedCachePolicy({ provider: c.kind, api: c.api, model: m.key })?.ttlS ??
                null),
          modelId: m.id,
          kind: c.kind,
          api: c.api,
          key: m.key,
          prefill: effective.prefill.value,
          continueUnavailable: prefillUnavailable(
            { kind: c.kind, api: c.api, key: m.key, prefill: effective.prefill.value },
            c.baseUrl
          ),
          cacheBreakpoints: effective.cacheBreakpoints.value,
          context:
            effective.settings.samplers?.openai_max_context ??
            (effective.context.source === "unknown" ? null : effective.context.value),
          maxOutput:
            effective.settings.samplers?.openai_max_tokens ??
            (effective.maxOutput.source === "unknown" ? null : effective.maxOutput.value),
          presetOverride: c.presetOverrideRefId
        }
        return resolvedModel
      }),

    // The scope chain (DATA-MODEL §5.4): the chat's role binding, the chat's own, the
    // connection's override, the user's default, the instance's, then ST's default. A level
    // that names something deleted is passed over.
    preset: () =>
      Effect.gen(function* () {
        const user = (yield* defaults).preset
        if (user !== null) {
          const found = yield* presetFrom(user, "user")
          if (found)
            return {
              ...found,
              doc: withModelSettings(
                found.doc,
                resolvedModel?.settings ?? {},
                resolvedModel?.context ?? 8192,
                resolvedModel?.maxOutput ?? 4096
              )
            }
        }
        return {
          ref: null,
          revision: null,
          scope: "builtin",
          doc: withModelSettings(builtinPreset, {}, 8192, 4096)
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
    /** What the sources read; a replay's are the pins it was given. */
    pins: (): SourcePins => replay?.pins ?? { ...pins, target: pins.target!, ...(layerPins ? { lcm: layerPins } : {}) },
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
        const rows =
          ids.length === 0
            ? []
            : yield* sql<{ id: string; content: string; amends: number }>`
                SELECT v.id, v.content, (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) AS amends
                FROM versions v JOIN slots s ON s.id = v.slot_id
                WHERE s.chat_id = ${chatId} AND ${owned} AND v.id IN ${sql.in(ids)}`
        const byId = new Map(rows.map((row) => [row.id, row]))
        const entries = yield* Effect.forEach(window.entries, ({ amends, ...entry }) =>
          Effect.gen(function* () {
            const row = byId.get(entry.versionId)
            if (!row) return yield* unpinned("a message")
            if (row.amends === amends) return { ...entry, content: row.content } satisfies HistoryEntry
            // Amended since: its text then is what the next amend replaced.
            const [earlier] = yield* sql<{ content: string }>`
              SELECT content FROM version_history WHERE version_id = ${entry.versionId}
              ORDER BY id LIMIT 1 OFFSET ${amends}`
            if (!earlier) return yield* unpinned("a message's earlier text")
            return { ...entry, content: earlier.content } satisfies HistoryEntry
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
        return yield* Effect.forEach(found, ({ entity, revision, first }) =>
          Effect.gen(function* () {
            const row = yield* revisionDoc(revision, "note", entity)
            if (!row) return yield* unpinned("a note")
            const doc = yield* decoded<NoteDoc>(decodeNote(JSON.parse(row.doc_json)), "A note")
            return { entity, revision, doc, first } satisfies NoteInput
          })
        )
      }),

    noteHistory: live.noteHistory,
    onPath: live.onPath,
    messageCount: (leaf) =>
      Effect.map(pinned(pins.messageCount ?? [], keyOf(leaf), "the path message count"), ({ count }) => count),
    // Which messages are the user's can change (another version selected): the count is pinned.
    userMessages: (leaf, personas, characters) =>
      Effect.map(
        pinned(pins.userMessages ?? [], keyOf(leaf, personas, characters), "part of the chat"),
        ({ count }) => count
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
              inputs.model?.context ?? 8192,
              inputs.model?.maxOutput ?? 4096
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
            withConditions(doc).doc,
            inputs.model?.settings ?? {},
            inputs.model?.context ?? 8192,
            inputs.model?.maxOutput ?? 4096
          )
        } satisfies PresetInput
      })
  }
}
