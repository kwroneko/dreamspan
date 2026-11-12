// A compensating presence event, retaining the original decision and payloads in History.
// All work runs in the calling writer transaction. Branch-local corrections reuse ordinary
// fork copies; shared versions are never changed for that setting.
import type { ChatId, EntityId, ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { parsePresence } from "@rp/shared/knowledge.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { displayLength, pathPieces, positionOf, slotPlace } from "./displayPath.ts"
import { effectiveOverride, nextSeq, originalSql, replacedIn, writeOverride } from "./forkState.ts"
import type { makeGraphWrites } from "./graphWrites.ts"
import { historyFork } from "./historyShared.ts"
import { presenceJson } from "./participation.ts"
import { stateEventRowsThrough } from "./stateRead.ts"

/** Chat metadata drives point probes of recorded presence, without reading swipe prose. */
export const presenceCandidatesFrom = `slots s CROSS JOIN versions v ON v.slot_id = s.id
  CROSS JOIN version_texts t INDEXED BY version_texts_presence ON t.version_seq = v.seq`

/** [P] Open owner question: correct every branch, or only the branch requesting Undo. */
const UNDO_CORRECTS_EVERY_BRANCH: boolean = true

interface Correction {
  readonly scope: "all" | "branch"
  readonly forks: ReadonlyArray<{ id: string; replacement: string }>
  readonly versions: ReadonlyArray<{ id: string; before: string; after: string | null }>
  readonly copies: ReadonlyArray<{ original: string; copy: string; previous: string | null; slot: string }>
}

const snapshot = (event: {
  id: string
  slot_id: string | null
  scope: string | null
  key: string
  value_json: string
}) => ({
  id: event.id,
  slotId: event.slot_id,
  content: JSON.stringify({ scope: event.scope, data: { key: event.key, value: JSON.parse(event.value_json) } })
})

export const correctPresence =
  (sql: SqlClient.SqlClient, graph: ReturnType<typeof makeGraphWrites>) =>
  ({
    userId,
    chatId,
    forkId,
    eventId
  }: {
    readonly userId: UserId
    readonly chatId: ChatId
    readonly forkId: ForkId
    readonly eventId: string
  }) =>
    Effect.gen(function* () {
      const own = yield* historyFork(sql, userId, chatId, forkId)
      const ownEvents = yield* stateEventRowsThrough(sql, chatId, own.tip_slot_id as SlotId | null, forkId)
      const event = ownEvents.find((e) => e.id === eventId)
      if (!event || event.slot_id === null || event.key !== "away.set") return null
      const value = JSON.parse(event.value_json) as { entity: EntityId; away: boolean; source?: string }
      if (!value.away || value.source !== "decision") return null
      const forks = UNDO_CORRECTS_EVERY_BRANCH
        ? yield* sql<{
            id: string
            tip_slot_id: string | null
          }>`SELECT id, tip_slot_id FROM forks WHERE chat_id = ${chatId} AND deleted_at IS NULL AND purged_at IS NULL`
        : [own]
      const affected: Array<{ id: string; rows: typeof ownEvents }> = []
      const versions = new Map<
        string,
        { id: string; seq: number; slot_id: string; original: string; before: string; after: string | null }
      >()
      const candidates = yield* sql<{
        id: string
        seq: number
        slot_id: string
        chain_id: string
        depth: number
        source_version_id: string | null
        fork_id: string | null
        written_in: string
        presence_json: string
      }>`
        SELECT v.id, v.seq, v.slot_id, s.chain_id, s.depth, v.source_version_id, v.fork_id,
          v.authoring_fork_id AS written_in, t.presence_json
        FROM ${sql.literal(presenceCandidatesFrom)}
        WHERE s.chat_id = ${chatId} AND t.presence_json IS NOT NULL AND v.purged_at IS NULL
          AND (${UNDO_CORRECTS_EVERY_BRANCH ? 1 : 0} = 1 OR v.id = ${replacedIn(sql, forkId, originalSql("v"))})`
      const byFork = new Map<string, Array<(typeof candidates)[number]>>()
      for (const row of candidates) {
        const rows = byFork.get(row.written_in) ?? []
        rows.push(row)
        byFork.set(row.written_in, rows)
      }
      for (const fork of forks) {
        const events =
          fork.id === forkId
            ? ownEvents
            : yield* stateEventRowsThrough(sql, chatId, fork.tip_slot_id as SlotId | null, fork.id)
        const at = events.findIndex((e) => e.id === eventId)
        if (at < 0) continue // off-path, suppressed, or attached to a swipe this fork doesn't show
        affected.push({ id: fork.id, rows: events })
        const pieces = yield* pathPieces(sql, chatId, fork.id, fork.tip_slot_id)
        const place = yield* slotPlace(sql, chatId, event.slot_id)
        const from = place ? positionOf(pieces, place) : null
        if (from == null) continue
        const identities = new Set<string>([value.entity])
        for (const e of events) {
          if (e.key !== "card.swap") continue
          const swap = JSON.parse(e.value_json) as { entity: string; replaces: string }
          if (identities.has(swap.replaces)) identities.add(swap.entity)
        }
        // Only effective events in this fork can end the correction. A later mark's own
        // message was written before that mark; messages below it belong to that mark.
        const next = events.slice(at + 1).find((e) => {
          if (!["away.set", "participant.join", "participant.leave"].includes(e.key)) return false
          return identities.has((JSON.parse(e.value_json) as { entity: string }).entity)
        })
        const nextPlace = next?.slot_id ? yield* slotPlace(sql, chatId, next.slot_id) : null
        const through = nextPlace ? positionOf(pieces, nextPlace)! : displayLength(pieces) - 1
        if (through <= from) continue
        const rows = UNDO_CORRECTS_EVERY_BRANCH ? (byFork.get(fork.id) ?? []) : candidates
        for (const row of rows) {
          const position = positionOf(pieces, { id: row.slot_id, chainId: row.chain_id, depth: row.depth })
          if (position === null || position <= from || position > through) continue
          const presence = parsePresence(row.presence_json)
          const away = (presence?.away ?? []).filter((id) => !identities.has(id))
          if (away.length === (presence?.away ?? []).length) continue
          const narrators = presence?.narrators ?? []
          const after = presenceJson(
            away.length || narrators.length
              ? { ...(away.length ? { away } : {}), ...(narrators.length ? { narrators } : {}) }
              : null
          )
          versions.set(row.id, {
            ...row,
            original: row.fork_id ? row.source_version_id! : row.id,
            before: row.presence_json,
            after
          })
        }
      }
      const group = uuidv7(),
        now = Date.now()
      yield* sql`INSERT INTO changeset_groups(id, owner_user_id, title, origin, created_at) VALUES (${group}, ${userId}, 'Correct scene check', 'user', ${now})`
      const correction: {
        scope: Correction["scope"]
        forks: Array<{ id: string; replacement: string }>
        versions: Correction["versions"]
        copies: Array<Correction["copies"][number]>
      } = { scope: UNDO_CORRECTS_EVERY_BRANCH ? "all" : "branch", forks: [], versions: [], copies: [] }
      const records: Array<{ id: string; replacement: string }> = []
      for (const fork of affected) {
        const replacement = yield* graph.insertStateEvent(
          userId,
          chatId,
          event.slot_id,
          event.version_id,
          event.scope as never,
          { key: "away.set", value: { entity: value.entity, away: false } },
          fork.id
        )
        correction.forks.push({ id: fork.id, replacement: replacement.id })
        const id = uuidv7(),
          seq = yield* nextSeq(sql, chatId)
        yield* sql`INSERT INTO changesets(id, chat_id, fork_id, seq, group_id, title, origin, status, created_at)
          VALUES (${id}, ${chatId}, ${fork.id}, ${seq}, ${group}, 'Correct scene check', 'user', 'applied', ${now})`
        yield* writeOverride(
          sql,
          { id: fork.id, chatId },
          { kind: "suppress_event", targetId: eventId, slotId: event.slot_id, valueId: replacement.id, flag: 1 }
        )
        yield* sql`UPDATE fork_overrides SET changeset_id = ${id} WHERE id = ${effectiveOverride(sql, "suppress_event", fork.id, `'${eventId.replaceAll("'", "''")}'`)}`
        records.push({ id, replacement: replacement.id })
      }
      if (UNDO_CORRECTS_EVERY_BRANCH) {
        correction.versions = [...versions.values()].map(({ id, before, after }) => ({ id, before, after }))
        // Updating the payload directly avoids the wide version_records view's metadata and
        // text update triggers. One statement, with the participation/stamp triggers retained.
        yield* sql`UPDATE version_texts SET presence_json = patch.value ->> 'after'
          FROM json_each(${JSON.stringify([...versions.values()].map(({ seq, after }) => ({ seq, after })))}) patch
          WHERE version_texts.version_seq = patch.value ->> 'seq'`
      } else {
        const fresh = new Set([
          "seq",
          "id",
          "ordinal",
          "source_version_id",
          "fork_id",
          "authoring_fork_id",
          "presence_json"
        ])
        const columns = (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('version_records')`)
          .map((c) => c.name)
          .filter((c) => !fresh.has(c))
        for (const row of versions.values()) {
          const copy = uuidv7()
          const [previous] = yield* sql<{
            value_id: string | null
          }>`SELECT value_id FROM fork_overrides WHERE id = ${effectiveOverride(sql, "replace", forkId, `'${row.original.replaceAll("'", "''")}'`)}`
          yield* sql.unsafe(
            `INSERT INTO version_records(id, ordinal, source_version_id, fork_id, authoring_fork_id, presence_json, ${columns.join(",")})
            SELECT ?, (SELECT max(ordinal)+1 FROM versions WHERE slot_id = v.slot_id), ?, ?, ?, ?, ${columns.map((c) => `v.${c}`).join(",")} FROM version_records v WHERE id = ?`,
            [copy, row.original, forkId, forkId, row.after, row.id]
          )
          yield* sql`INSERT INTO version_attachments(version_id, ordinal, media_id, kind, alt_text) SELECT ${copy}, ordinal, media_id, kind, alt_text FROM version_attachments WHERE version_id = ${row.id}`
          yield* writeOverride(
            sql,
            { id: forkId, chatId },
            { kind: "replace", targetId: row.original, slotId: row.slot_id, valueId: copy, flag: null }
          )
          correction.copies.push({
            original: row.original,
            copy,
            previous: previous?.value_id ?? null,
            slot: row.slot_id
          })
        }
      }
      for (const record of records) {
        const [replacement] = yield* sql<{
          id: string
          slot_id: string | null
          scope: string | null
          key: string
          value_json: string
        }>`SELECT * FROM state_events WHERE id = ${record.replacement}`
        yield* sql`INSERT INTO changeset_items(changeset_id, target_kind, target_id, before_json, after_json)
          VALUES (${record.id}, 'state_event', ${eventId}, ${JSON.stringify(snapshot(event))}, ${JSON.stringify({ ...snapshot(replacement!), presenceCorrectionGroup: group, ...(record.id === records[0]!.id ? { presenceCorrection: correction } : {}) })})`
      }
      return {
        eventId: correction.forks.find((f) => f.id === forkId)!.replacement,
        corrected: (UNDO_CORRECTS_EVERY_BRANCH
          ? [...versions.keys()]
          : correction.copies.map((copy) => copy.copy)) as Array<VersionId>
      }
    })

/** Undo the correction at its recorded scope. Null: an ordinary history edit; false: conflict. */
export const undoPresenceCorrection = (
  sql: SqlClient.SqlClient,
  chatId: string,
  eventId: string,
  group: string | undefined
) =>
  Effect.gen(function* () {
    if (!group) return null
    const [item] = yield* sql<{
      correction: string
    }>`SELECT json_extract(i.after_json, '$.presenceCorrection') AS correction
    FROM changeset_items i JOIN changesets c ON c.id = i.changeset_id
    WHERE c.group_id = ${group} AND c.chat_id = ${chatId} AND json_type(i.after_json, '$.presenceCorrection') = 'object' LIMIT 1`
    if (!item) return false
    const correction = JSON.parse(item.correction) as Correction
    const [source] = yield* sql<{
      slot_id: string | null
    }>`SELECT slot_id FROM state_events WHERE id = ${eventId} AND chat_id = ${chatId}`
    if (!source) return false
    const [conflicts] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM json_each(${JSON.stringify(correction.versions)}) old
    LEFT JOIN versions v ON v.id = old.value ->> 'id' LEFT JOIN version_texts t ON t.version_seq = v.seq
    WHERE v.id IS NULL OR t.presence_json IS NOT (old.value ->> 'after')`
    if (conflicts!.n) return false
    for (const fork of correction.forks) {
      const [current] = yield* sql<{
        value_id: string | null
        flag: number
      }>`SELECT value_id, flag FROM fork_overrides WHERE id = ${effectiveOverride(sql, "suppress_event", fork.id, `'${eventId.replaceAll("'", "''")}'`)}`
      if (current?.flag !== 1 || current.value_id !== fork.replacement) return false
    }
    for (const row of correction.copies) {
      const [current] = yield* sql<{
        value_id: string | null
      }>`SELECT value_id FROM fork_overrides WHERE id = ${effectiveOverride(sql, "replace", correction.forks[0]!.id, `'${row.original.replaceAll("'", "''")}'`)}`
      if (current?.value_id !== row.copy) return false
    }
    // Forks created after an all-branch correction inherited its mark. Its inverse must
    // cover those too, because the corrected payloads are shared by those forks.
    const forks =
      correction.scope === "all"
        ? yield* sql<{ id: string; replacement: string }>`
      SELECT f.id, o.value_id AS replacement FROM forks f JOIN fork_overrides o
        ON o.id = ${effectiveOverride(sql, "suppress_event", sql`f.id`, `'${eventId.replaceAll("'", "''")}'`)}
      WHERE f.chat_id = ${chatId} AND o.flag = 1 AND o.value_id IN (SELECT value ->> 'replacement' FROM json_each(${JSON.stringify(correction.forks)}))`
        : correction.forks
    yield* sql`UPDATE version_texts SET presence_json = old.value ->> 'before'
      FROM json_each(${JSON.stringify(correction.versions)}) old JOIN versions v ON v.id = old.value ->> 'id'
      WHERE version_texts.version_seq = v.seq`
    for (const fork of forks) {
      yield* writeOverride(
        sql,
        { id: fork.id, chatId },
        { kind: "suppress_event", targetId: eventId, slotId: source.slot_id, valueId: null, flag: 0 }
      )
      yield* writeOverride(
        sql,
        { id: fork.id, chatId },
        { kind: "suppress_event", targetId: fork.replacement, slotId: source.slot_id, valueId: null, flag: 1 }
      )
    }
    for (const row of correction.copies)
      yield* writeOverride(
        sql,
        { id: correction.forks[0]!.id, chatId },
        { kind: "replace", targetId: row.original, slotId: row.slot, valueId: row.previous, flag: null }
      )
    return true
  })
