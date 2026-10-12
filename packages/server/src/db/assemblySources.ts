// The assembler's sources over the database, every read the acting user's, and the pins a
// rebuild reads again (ARCHITECTURE §15).
import type { ChatId } from "@rp/shared/chat.ts"
import { CardDoc } from "@rp/shared/docs/card.ts"
import { NoteDoc } from "@rp/shared/docs/note.ts"
import { PresetDoc } from "@rp/shared/docs/preset.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { resolveModel } from "@rp/shared/providers.ts"
import { FoldableEvent } from "@rp/shared/state.ts"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import { AssemblySources, type PositionedEvent } from "../assembler/pipeline.ts"
import {
  AssemblyFailed,
  type CardInput,
  type HistoryEntry,
  type NoteInput,
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
import { withoutPurged } from "./stateRefs.ts"

const decodeEvent = Schema.decodeUnknownEffect(FoldableEvent)
const decodeCard = Schema.decodeUnknownExit(CardDoc)
const decodeNote = Schema.decodeUnknownExit(NoteDoc)
const decodePreset = Schema.decodeUnknownExit(PresetDoc)

/** ST's default chat-completion preset: what generation uses when nothing chooses one. */
const builtinPreset = importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!

const invalid = (what: string) =>
  new AssemblyFailed({
    reason: "invalid_document",
    message: `${what} doesn't match its format any more, so it can't be used. Edit it, or choose another.`
  })

const decoded = <A>(
  exit: ReturnType<typeof decodeCard> | ReturnType<typeof decodeNote> | ReturnType<typeof decodePreset>,
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

interface Settings {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly slotId: string
  readonly versionId: string
}

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
export const sqlSources = (
  sql: SqlClient.SqlClient,
  { userId, chatId, slotId, versionId }: Settings,
  replay?: Replay
) => {
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
    sql<{ id: string; entity_id: string; head_revision_id: string; doc_json: string }>`
      SELECT r.id, r.entity_id, r.head_revision_id, h.doc_json FROM entity_refs r
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
      const doc = yield* decoded<PresetDoc>(decodePreset(JSON.parse(row.doc_json)), "The preset")
      return { ref: row.ref, revision: row.revision, scope, doc } satisfies PresetInput
    })

  const pins = {
    target: null as Target | null,
    events: [] as Array<SourcePins["events"][number]>,
    history: [] as Array<SourcePins["history"][number]>,
    cards: [] as Array<SourcePins["cards"][number]>,
    notes: [] as Array<SourcePins["notes"][number]>
  }

  const live = AssemblySources.of({
    target: sql<{
      depth: number
      parent_slot_id: string | null
      ordinal: number
      speaker_entity_id: string | null
      direction: string | null
    }>`
      SELECT s.depth, s.parent_slot_id, v.ordinal, v.speaker_entity_id, v.direction
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
              direction: row.direction
            })
          : Effect.fail(new NotFound({ entity: "version", id: versionId }))
      ),
      Effect.tap((target) =>
        Effect.sync(() => {
          pins.target = target
        })
      )
    ),

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

    history: (leaf, limit) =>
      Effect.gen(function* () {
        const rows = yield* sql<HistoryRow>`
          WITH RECURSIVE path(id, n) AS (
            SELECT id, 1 FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND ${owned}
            UNION ALL
            SELECT s.parent_slot_id, p.n + 1 FROM slots s JOIN path p ON s.id = p.id
            WHERE s.parent_slot_id IS NOT NULL AND p.n < ${limit}
          )
          SELECT s.id AS slot_id, s.parent_slot_id, s.depth, s.context_excluded,
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
        const older = rows[0]?.parent_slot_id ?? null
        pins.history.push({ key: keyOf(leaf, limit), older, entries: read.map(({ content: _, ...pinned }) => pinned) })
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

    model: (binding) =>
      Effect.gen(function* () {
        const chosen = binding ?? (yield* defaults).model
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
        return {
          connectionId: c.id,
          modelId: m.id,
          kind: c.kind,
          api: c.api,
          key: m.key,
          prefill: effective.prefill.value,
          cacheBreakpoints: effective.cacheBreakpoints.value,
          context: effective.context.source === "unknown" ? null : effective.context.value,
          presetOverride: c.presetOverrideRefId
        }
      }),

    // The scope chain (DATA-MODEL §5.4): the chat's role binding, the chat's own, the
    // connection's override, the user's default, the instance's, then ST's default. A level
    // that names something deleted is passed over.
    preset: (chain) =>
      Effect.gen(function* () {
        if (chain.role) {
          const found = yield* presetFrom(chain.role, "role")
          if (found) return found
        }
        if (chain.chat) {
          const found = yield* presetFrom(chain.chat, "chat")
          if (found) return found
        }
        if (chain.connection) {
          const found = yield* presetFrom(chain.connection, "connection")
          if (found) return found
        }
        const user = (yield* defaults).preset
        if (user !== null) {
          const found = yield* presetFrom(user, "user")
          if (found) return found
        }
        return { ref: null, revision: null, scope: "builtin", doc: builtinPreset } satisfies PresetInput
      })
  })

  const sources = replay
    ? replaySources(sql, { userId, chatId }, replay, (revision, kind, entity) =>
        // A revision never changes: one of an entity in the bin still reads as it was.
        revisionDoc(revision, kind, entity, true)
      )
    : live
  return {
    layer: Layer.succeed(AssemblySources)(sources),
    /** What the sources read; a replay's are the pins it was given. */
    pins: (): SourcePins => replay?.pins ?? { ...pins, target: pins.target! }
  }
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
  ) => Effect.Effect<{ entity_id: string; doc_json: string } | undefined, SqlError.SqlError>
): AssemblySources["Service"] => {
  const owned = sql`EXISTS (SELECT 1 FROM chats o WHERE o.id = ${chatId} AND o.owner_user_id = ${userId})`
  const pinned = <A extends { readonly key: string }>(list: ReadonlyArray<A>, key: string, what: string) => {
    const found = list.find((p) => p.key === key)
    return found ? Effect.succeed(found) : Effect.fail(unpinned(what))
  }
  return {
    target: sql<{ ok: number }>`SELECT ${owned} AS ok`.pipe(
      Effect.flatMap(([row]) =>
        row?.ok ? Effect.succeed(pins.target) : Effect.fail(new NotFound({ entity: "chat", id: chatId }))
      )
    ),

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

    history: (leaf, limit) =>
      Effect.gen(function* () {
        const window = yield* pinned(pins.history, keyOf(leaf, limit), "part of the chat")
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

    model: () => Effect.succeed(inputs.model),

    preset: () =>
      Effect.gen(function* () {
        const { ref, revision, scope } = inputs.preset
        if (revision === null) return { ref, revision, scope, doc: builtinPreset } satisfies PresetInput
        const row = yield* revisionDoc(revision, "preset")
        if (!row) return yield* unpinned("the preset")
        const doc = yield* decoded<PresetDoc>(decodePreset(JSON.parse(row.doc_json)), "The preset")
        return { ref, revision, scope, doc } satisfies PresetInput
      })
  }
}
