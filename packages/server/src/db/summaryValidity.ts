// Which forks' shell summaries a write left right (db/forkSummaries.ts). The triggers in
// db/baseline.ts move a chat's `shell_stamp` on every write its summaries read, so a summary is
// valid while its `stamp` is the chat's. Alone, that makes one fork's write stale every fork of
// the chat: a chat with hundreds of branches walked them all again. Here the writer's own
// connection also notes what each write touched (TEMP triggers: nothing in the database file
// changes), and at the end of every write transaction moves the stamp of each summary the
// touched rows can't reach on to the chat's new one. What a summary reads, and who it reaches:
// - a slot's shown fields (`slots` columns, its versions): the forks whose tip is it or below it.
//   A new slot reaches none (no fork's path holds it until a fork's tip moves, below);
//   a new version neither (it's shown only once a selection or replacement names it).
// - a fork's row (tip, lineage, deletion): that fork.
// - an override or a state event a fork wrote, at its sequence number: the forks whose lineage
//   holds that fork up to at least that number. A snapshot of a fork: every fork whose
//   lineage holds it.
// - anything else (a moved slot, an insertion, a chat-wide event, an event changed in place):
//   every fork of the chat, as before.
// A summary that wasn't valid when the write began stays stale. Only the writer writes; a
// write on another connection notes nothing, so summaries from before it never match again.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

const SELF = "self"
const FORK = "fork"
const SLOT = "slot"
const CHAT = "chat"

/** Notes a touch: `kind`, the chat, the row it names and a sequence number (SQL expressions), when `when` holds. */
const touch = (kind: string, chat: string, ref = "NULL", seq = "NULL", when = "1") =>
  `INSERT INTO shell_touches (kind, chat_id, ref, seq) SELECT '${kind}', ${chat}, ${ref}, ${seq} WHERE ${when};`

/** The kinds of override a summary reads (baseline's shell_fork_overrides_* triggers). */
const READ_OVERRIDES = `('select', 'replace', 'delete_slot', 'insert', 'suppress_event')`

/** An insertion changes which slots paths show; the other kinds reach their fork's lineage. */
const overrideTouch = (row: string) =>
  `${touch(CHAT, `${row}.chat_id`, "NULL", "NULL", `${row}.kind = 'insert'`)}
  ${touch(FORK, `${row}.chat_id`, `${row}.fork_id`, `${row}.seq`, `${row}.kind IN ${READ_OVERRIDES} AND ${row}.kind <> 'insert'`)}`

const slotChat = (slot: string) => `(SELECT chat_id FROM slots WHERE id = ${slot})`
const forkChat = (fork: string) => `(SELECT chat_id FROM forks WHERE id = ${fork})`

const statements: ReadonlyArray<string> = [
  `CREATE TEMP TABLE IF NOT EXISTS shell_moved (chat_id TEXT PRIMARY KEY, stamp INTEGER NOT NULL)`,
  `CREATE TEMP TABLE IF NOT EXISTS shell_touches (kind TEXT NOT NULL, chat_id TEXT, ref TEXT, seq INTEGER)`,
  // The stamp each chat had when this transaction's writes began moving it. Not OR IGNORE: an
  // outer statement's conflict policy replaces a trigger statement's.
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_moved_chat BEFORE UPDATE OF shell_stamp ON main.chats
    WHEN NEW.shell_stamp IS NOT OLD.shell_stamp AND NOT EXISTS (SELECT 1 FROM shell_moved WHERE chat_id = OLD.id)
    BEGIN INSERT INTO shell_moved (chat_id, stamp) VALUES (OLD.id, OLD.shell_stamp); END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_slot_moved AFTER UPDATE OF chat_id, parent_slot_id, depth, inserted
    ON main.slots BEGIN ${touch(CHAT, "OLD.chat_id")} ${touch(CHAT, "NEW.chat_id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_slot AFTER UPDATE OF selected_version_id, created_at, deleted_at,
    purged_at ON main.slots BEGIN ${touch(SLOT, "NEW.chat_id", "NEW.id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_slot_delete AFTER DELETE ON main.slots
    BEGIN ${touch(CHAT, "OLD.chat_id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_version AFTER UPDATE OF slot_id, speaker_entity_id, content, origin,
    source_version_id, created_at, deleted_at, purged_at, fork_id ON main.versions
    BEGIN ${touch(SLOT, slotChat("OLD.slot_id"), "OLD.slot_id")} ${touch(SLOT, slotChat("NEW.slot_id"), "NEW.slot_id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_version_delete AFTER DELETE ON main.versions
    BEGIN ${touch(SLOT, slotChat("OLD.slot_id"), "OLD.slot_id")} END`,
  ...(["insert", "update", "delete"] as const).flatMap((op) => {
    const rows = op === "insert" ? ["NEW"] : op === "delete" ? ["OLD"] : ["OLD", "NEW"]
    const when = rows.map((row) => `${row}.kind IN ${READ_OVERRIDES}`).join(" OR ")
    return [
      `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_override_${op} AFTER ${op.toUpperCase()} ON main.fork_overrides
        WHEN ${when} BEGIN ${rows.map(overrideTouch).join(" ")} END`
    ]
  }),
  // A new event is visible where its fork's lineage reaches its number; one changed or
  // removed in place may be in other forks' snapshots too.
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_event_insert AFTER INSERT ON main.state_events BEGIN
    ${touch(CHAT, "NEW.chat_id", "NULL", "NULL", "NEW.fork_id IS NULL OR NEW.fork_seq IS NULL")}
    ${touch(FORK, "NEW.chat_id", "NEW.fork_id", "NEW.fork_seq", "NEW.fork_id IS NOT NULL AND NEW.fork_seq IS NOT NULL")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_event_update AFTER UPDATE OF chat_id, slot_id, version_id, seq, key,
    scope, value_json, fork_id, fork_seq, superseded_by_changeset ON main.state_events
    BEGIN ${touch(CHAT, "OLD.chat_id")} ${touch(CHAT, "NEW.chat_id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_event_delete AFTER DELETE ON main.state_events
    BEGIN ${touch(CHAT, "OLD.chat_id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_fork_insert AFTER INSERT ON main.forks
    BEGIN ${touch(SELF, "NEW.chat_id", "NEW.id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_fork_update AFTER UPDATE OF chat_id, parent_fork_id, tip_slot_id,
    deleted_at, purged_at, lineage_json ON main.forks
    BEGIN ${touch(SELF, "OLD.chat_id", "OLD.id")} ${touch(SELF, "NEW.chat_id", "NEW.id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_fork_delete AFTER DELETE ON main.forks
    BEGIN ${touch(SELF, "OLD.chat_id", "OLD.id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_snapshot_insert AFTER INSERT ON main.fork_event_snapshots
    BEGIN ${touch(FORK, forkChat("NEW.fork_id"), "NEW.fork_id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_snapshot_delete AFTER DELETE ON main.fork_event_snapshots
    BEGIN ${touch(FORK, forkChat("OLD.fork_id"), "OLD.fork_id")} END`
]

/** Whether this thread's connection notes touches: only the writer's does. */
let tracking = false

/** Installs the notes on the writer's connection, once, after the migrations. */
export const trackSummaryTouches = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    for (const statement of statements) yield* sql.unsafe(statement)
    tracking = true
  })

/**
 * Moves the stamp of every summary of a chat this transaction's writes moved that they can't
 * reach on to the chat's stamp now, and forgets the notes. Run inside the write's transaction:
 * at its end (`transaction` in tx.ts), and before a write computes summaries itself.
 */
export const settleSummaries = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    if (!tracking) return
    const moved = yield* sql<{ chat_id: string; stamp: number }>`SELECT chat_id, stamp FROM shell_moved`
    if (moved.length > 0) {
      yield* sql`WITH RECURSIVE
        kept(chat_id, stamp) AS (
          SELECT m.chat_id, m.stamp FROM shell_moved m WHERE NOT EXISTS (
            SELECT 1 FROM shell_touches t WHERE t.chat_id = m.chat_id AND (t.kind = ${CHAT}
              -- A chat with insertions shows slots off its tree's paths.
              OR (t.kind = ${SLOT} AND EXISTS (
                SELECT 1 FROM fork_overrides o WHERE o.chat_id = m.chat_id AND o.kind = 'insert'))))),
        below(id) AS (
          SELECT t.ref FROM shell_touches t JOIN kept k ON k.chat_id = t.chat_id WHERE t.kind = ${SLOT}
          UNION SELECT s.id FROM below b JOIN slots s ON s.parent_slot_id = b.id),
        reached(id) AS (
          SELECT t.ref FROM shell_touches t WHERE t.kind IN (${SELF}, ${FORK})
          UNION ALL SELECT f.id FROM kept k JOIN forks f ON f.chat_id = k.chat_id
            WHERE f.tip_slot_id IN (SELECT id FROM below)
          UNION ALL SELECT f.id FROM shell_touches t JOIN kept k ON k.chat_id = t.chat_id
            JOIN forks f ON f.chat_id = t.chat_id CROSS JOIN json_each(f.lineage_json) l
            WHERE t.kind = ${FORK} AND l.value ->> 0 = t.ref
              AND (t.seq IS NULL OR l.value ->> 1 IS NULL OR l.value ->> 1 >= t.seq))
        UPDATE fork_summaries SET stamp = (SELECT c.shell_stamp FROM chats c WHERE c.id = fork_summaries.chat_id)
        WHERE fork_id IN (
          SELECT s.fork_id FROM kept k JOIN fork_summaries s ON s.chat_id = k.chat_id AND s.stamp = k.stamp
          WHERE s.fork_id NOT IN (SELECT id FROM reached))`
      yield* sql`DELETE FROM shell_moved`
    }
    yield* sql`DELETE FROM shell_touches`
  })
