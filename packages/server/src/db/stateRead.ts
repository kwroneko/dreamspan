import type { SqlClient } from "effect/sql"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { pathEvents } from "./pathSegments.ts"
import { displayEvents, displayThrough, type PathPiece } from "./displayPath.ts"
import { attachedApplies, eventApplies, eventOrder, slotDeletedIn } from "./forkState.ts"

/**
 * The state events that apply at `slotId` (StateEventsAt) in fork `fork` (null: the chat's current fork), in fold order: chat-wide ones, then by depth. An
 * event attached to a version applies while the fork shows it. Its cost is the path's
 * segments and events, not its length.
 */
type StateEventRow = { key: string; scope: string | null; value_json: string }
type ProvenancedEventRow = StateEventRow & {
  readonly id: string
  readonly origin: string
  readonly version_id: string | null
}

const eventsOnPath = <A extends StateEventRow>(
  sql: SqlClient.SqlClient,
  chatId: ChatId,
  slotId: SlotId | null,
  fork: string | null,
  columns: string,
  shown: ReadonlyArray<PathPiece> | null = null
) => {
  const view = fork ?? sql`(SELECT current_fork_id FROM chats WHERE id = ${chatId})`
  return sql<A>`
    ${shown === null ? pathEvents(sql, chatId, slotId) : displayEvents(sql, chatId, shown)}
    SELECT ${sql.literal(columns)}
    FROM path_events ev LEFT JOIN slots s ON s.id = ev.slot_id
    WHERE ${eventApplies(sql, view, "ev")}
      AND (ev.slot_id IS NULL OR NOT ${slotDeletedIn(sql, view, "s")})
      AND ${attachedApplies(sql, view, "s", "ev.version_id")}
    ORDER BY ${sql.literal(shown === null ? eventOrder("ev") : eventOrder("ev", "ev.position"))}`
}

/**
 * The display path through `slotId` in `fork` (null: the chat's current fork), when the fork
 * places insertions (`displayThrough`); null: the structural path is the display path.
 */
const displayIn = (sql: SqlClient.SqlClient, chatId: ChatId, slotId: SlotId | null, fork: string | null) =>
  Effect.gen(function* () {
    if (slotId === null) return null
    const id =
      fork ??
      (yield* sql<{ id: string | null }>`SELECT current_fork_id AS id FROM chats WHERE id = ${chatId}`)[0]?.id ??
      null
    return (yield* displayThrough(sql, chatId, id, slotId))?.pieces ?? null
  })

/** The existing assembly/editor projection, without provenance columns. */
export const stateEventsOnPath = (
  sql: SqlClient.SqlClient,
  chatId: ChatId,
  slotId: SlotId | null,
  fork: string | null = null
) => eventsOnPath<StateEventRow>(sql, chatId, slotId, fork, "ev.key, ev.scope, ev.value_json")

/**
 * `stateEventsOnPath` on the fork's display path (spec/MESSAGE-INSERT.md §3.1): in a fork that
 * places insertions, the events through `slotId` in display order, so an inserted message's
 * events fold between those of the messages around it. Without insertions it's
 * `stateEventsOnPath`, after one index probe per lineage entry.
 */
export const stateEventsThrough = (
  sql: SqlClient.SqlClient,
  chatId: ChatId,
  slotId: SlotId | null,
  fork: string | null = null
) =>
  Effect.flatMap(displayIn(sql, chatId, slotId, fork), (shown) =>
    eventsOnPath<StateEventRow>(sql, chatId, slotId, fork, "ev.key, ev.scope, ev.value_json", shown)
  )

/**
 * The fork preview additionally needs event identity and human/version provenance; on the
 * fork's display path, as `stateEventsThrough`.
 */
export const stateEventRowsThrough = (sql: SqlClient.SqlClient, chatId: ChatId, slotId: SlotId | null, fork: string) =>
  Effect.flatMap(displayIn(sql, chatId, slotId, fork), (shown) =>
    eventsOnPath<ProvenancedEventRow>(
      sql,
      chatId,
      slotId,
      fork,
      "ev.id, ev.origin, ev.version_id, ev.key, ev.scope, ev.value_json",
      shown
    )
  )

/**
 * A card fork carries every note switch on the path, including switches on unselected
 * versions and deleted slots: swiping or restoring later must retain those settings.
 * Keep this positional projection separate from stateEventsOnPath's public row shape.
 */
export const noteSwitchesOnPath = (sql: SqlClient.SqlClient, chatId: ChatId, slotId: SlotId | null, fork: string) =>
  Effect.flatMap(
    displayIn(sql, chatId, slotId, fork),
    (shown) => sql<{
      key: "note.activate" | "note.deactivate"
      value_json: string
      slot_id: string | null
      version_id: string | null
    }>`
      ${shown === null ? pathEvents(sql, chatId, slotId) : displayEvents(sql, chatId, shown)}
      SELECT ev.key, ev.value_json, ev.slot_id, ev.version_id FROM path_events ev
      WHERE ev.key IN ('note.activate', 'note.deactivate') AND ${eventApplies(sql, fork, "ev")}
      ORDER BY ${sql.literal(shown === null ? eventOrder("ev") : eventOrder("ev", "ev.position"))}`
  )
