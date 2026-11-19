// A branch's correction of a scene check. All work runs in the calling writer transaction;
// shared versions, summaries, and existing child branches retain their original records.
import type { ChatId, EntityId, ForkId, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { displayLength, pathPieces, positionOf, slotPlace } from "./displayPath.ts"
import { effectiveOverride, nextSeq, originalSql, replacedIn, writeOverride } from "./forkState.ts"
import type { makeGraphWrites } from "./graphWrites.ts"
import { historyFork } from "./historyShared.ts"
import { stateEventRowsThrough } from "./stateRead.ts"
import { presenceSpans, type PresenceRange } from "./presenceRanges.ts"

/** Chat metadata drives point probes of recorded presence, without reading swipe prose. */
export const presenceCandidatesFrom = `slots s CROSS JOIN versions v ON v.slot_id = s.id
  CROSS JOIN version_texts t INDEXED BY version_texts_presence ON t.version_seq = v.seq`

interface Correction {
  readonly fork: string
  readonly replacement: string
  readonly target: string
  readonly range: PresenceRange
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
      const events = yield* stateEventRowsThrough(sql, chatId, own.tip_slot_id as SlotId | null, forkId)
      const at = events.findIndex((e) => e.id === eventId)
      const event = events[at]
      if (!event || event.slot_id === null || event.key !== "away.set") return null
      const value = JSON.parse(event.value_json) as { entity: EntityId; away: boolean; source?: string }
      if (value.source !== "decision") return null
      const pieces = yield* pathPieces(sql, chatId, forkId, own.tip_slot_id)
      const place = yield* slotPlace(sql, chatId, event.slot_id)
      const from = place ? positionOf(pieces, place) : null
      if (from === null) return null
      const identities = new Set<string>([value.entity])
      for (const e of events) {
        if (e.key !== "card.swap") continue
        const swap = JSON.parse(e.value_json) as { entity: string; replaces: string }
        if (identities.has(swap.replaces)) identities.add(swap.entity)
      }
      const next = events
        .slice(at + 1)
        .find(
          (e) =>
            ["away.set", "participant.join", "participant.leave"].includes(e.key) &&
            identities.has((JSON.parse(e.value_json) as { entity: string }).entity)
        )
      const nextPlace = next?.slot_id ? yield* slotPlace(sql, chatId, next.slot_id) : null
      const through = nextPlace ? positionOf(pieces, nextPlace)! : displayLength(pieces) - 1
      const [last] = yield* sql<{ seq: number }>`SELECT coalesce(max(seq),0) AS seq FROM versions`
      const range: PresenceRange = {
        identities: [...identities],
        away: !value.away,
        cutoff: last!.seq,
        spans: presenceSpans(pieces, from + 1, through)
      }
      const group = uuidv7(),
        id = uuidv7(),
        now = Date.now()
      const replacement = yield* graph.insertStateEvent(
        userId,
        chatId,
        event.slot_id,
        event.version_id,
        event.scope as never,
        { key: "away.set", value: { entity: value.entity, away: !value.away } },
        forkId
      )
      yield* sql`INSERT INTO changeset_groups(id, owner_user_id, title, origin, created_at)
      VALUES (${group}, ${userId}, 'Correct scene check', 'user', ${now})`
      const seq = yield* nextSeq(sql, chatId)
      yield* sql`INSERT INTO changesets(id, chat_id, fork_id, seq, group_id, title, origin, status, created_at)
      VALUES (${id}, ${chatId}, ${forkId}, ${seq}, ${group}, 'Correct scene check', 'user', 'applied', ${now})`
      yield* writeOverride(
        sql,
        { id: forkId, chatId },
        {
          kind: "suppress_event",
          targetId: eventId,
          slotId: event.slot_id,
          valueId: replacement.id,
          flag: 1,
          changesetId: id
        }
      )
      yield* writeOverride(
        sql,
        { id: forkId, chatId },
        {
          kind: "presence_range",
          targetId: id,
          slotId: event.slot_id,
          valueId: JSON.stringify(range),
          flag: 1,
          changesetId: id
        }
      )
      const correction: Correction = { fork: forkId, replacement: replacement.id, target: id, range }
      yield* sql`INSERT INTO changeset_items(changeset_id, target_kind, target_id, before_json, after_json)
      VALUES (${id}, 'state_event', ${eventId}, ${JSON.stringify(snapshot(event))},
        ${JSON.stringify({ ...snapshot({ id: replacement.id, slot_id: event.slot_id, scope: event.scope, key: "away.set", value_json: JSON.stringify({ entity: value.entity, away: !value.away }) }), presenceCorrectionGroup: group, presenceCorrection: correction })})`
      // Return affected identities without loading payload text, cloning swipes, or touching their stamps.
      const corrected = yield* sql<{ id: string }>`SELECT v.id FROM json_each(${JSON.stringify(range.spans)}) span
      CROSS JOIN slots s ON s.chain_id=span.value ->> 'chain' AND s.depth BETWEEN span.value ->> 'lo' AND span.value ->> 'hi'
      CROSS JOIN versions v ON v.slot_id=s.id CROSS JOIN version_texts t ON t.version_seq=v.seq
      WHERE s.chat_id=${chatId} AND v.purged_at IS NULL AND v.id=${replacedIn(sql, forkId, originalSql("v"))}
        AND ((${value.away ? 1 : 0}=0) OR EXISTS (SELECT 1 FROM json_each(t.presence_json, '$.away') a
          WHERE a.value IN (SELECT value FROM json_each(${JSON.stringify([...identities])}))))`
      return { eventId: replacement.id, corrected: corrected.map((r) => r.id as VersionId) }
    })

/** History's inverse acts on the tab's fork, including a child inheriting this correction. */
export const undoPresenceCorrection = (
  sql: SqlClient.SqlClient,
  chatId: string,
  forkId: string,
  eventId: string,
  group: string | undefined
) =>
  Effect.gen(function* () {
    if (!group) return null
    const [item] = yield* sql<{
      correction: string
    }>`SELECT json_extract(i.after_json, '$.presenceCorrection') AS correction
      FROM changeset_items i JOIN changesets c ON c.id=i.changeset_id
      WHERE c.group_id=${group} AND c.chat_id=${chatId} AND json_type(i.after_json, '$.presenceCorrection')='object' LIMIT 1`
    if (!item) return false
    const correction = JSON.parse(item.correction) as Correction
    const [source] = yield* sql<{
      slot_id: string
    }>`SELECT slot_id FROM state_events WHERE id=${eventId} AND chat_id=${chatId}`
    const [current] = yield* sql<{ flag: number; value_id: string | null }>`SELECT flag, value_id FROM fork_overrides
      WHERE id=${effectiveOverride(sql, "suppress_event", forkId, `'${eventId.replaceAll("'", "''")}'`)}`
    const [range] = yield* sql<{ flag: number; value_id: string }>`SELECT flag,value_id FROM fork_overrides
      WHERE id=${effectiveOverride(sql, "presence_range", forkId, `'${correction.target.replaceAll("'", "''")}'`)}`
    if (
      !source ||
      current?.flag !== 1 ||
      current.value_id !== correction.replacement ||
      range?.flag !== 1 ||
      range.value_id !== JSON.stringify(correction.range)
    )
      return false
    const fork = { id: forkId, chatId }
    yield* writeOverride(sql, fork, {
      kind: "presence_range",
      targetId: correction.target,
      slotId: source.slot_id,
      valueId: range.value_id,
      flag: 0
    })
    yield* writeOverride(sql, fork, {
      kind: "suppress_event",
      targetId: eventId,
      slotId: source.slot_id,
      valueId: null,
      flag: 0
    })
    yield* writeOverride(sql, fork, {
      kind: "suppress_event",
      targetId: correction.replacement,
      slotId: source.slot_id,
      valueId: null,
      flag: 1
    })
    return true
  })
