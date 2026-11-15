// Which forks' shell summaries a write left right (db/forkSummaries.ts). The triggers in
// db/baseline.ts move a chat's `shell_stamp` on every write its summaries read. Alone, that
// makes one fork's write stale every fork of the chat: a chat with hundreds of branches walked
// them all again, and a walk that took longer than the chat's next write could never be stored.
// Here the writer's own connection also notes what each write touched (TEMP triggers: nothing
// in the database file changes), and at the end of every write transaction moves the
// `fork_shell_stamps` row of each fork the touched rows reach to the chat's new stamp. A summary
// computed at a chat stamp at or after its fork's is valid (`summaryValidSql`), so a write costs
// the forks it reaches, and a summary computed meanwhile for any other fork can still be
// stored. `chat_shell_tracked` keeps the chat's stamp after the last noted write: a move it
// didn't note (another connection, a write before the notes were installed) reaches every
// fork of the chat at the next noted write, and until then only a summary computed at the
// chat's stamp now is valid. What a
// summary reads, and who it reaches:
// - a slot's shown fields (`slots` columns, its versions): the forks whose tip is it or below it.
//   A new slot reaches none (no fork's path holds it until a fork's tip moves, below);
//   Every retained version contributes participation, even an unselected alternative.
//   A newly inserted alternative reaches other forks only for new participation or
//   human-author activity their stored summary doesn't already cover; the selection
//   override independently reaches the editing fork and its inheriting descendants.
// - a fork's row (tip, deletion): that fork. Where a fork splits off reads its
//   parent's path too: a fork's tip moving reaches its children whose tips are below a slot
//   one of its paths holds and the other doesn't (the slots between the two tips and their
//   common ancestor); its deletion, restore or removal, or a tip from or to none, all its children.
// - an override or a state event a fork wrote, at its sequence number: the forks whose lineage
//   holds that fork up to at least that number, the forks whose points lie from the writer's
//   point at that number to its end (db/forkLabels.ts). Insert placement overrides follow this
//   rule too: a new fork's exclusion after its base changes no existing fork's display.
// - anything else (a moved slot, an insertion, a chat-wide event, an event changed in place):
//   every fork of the chat, as before.
// A summary that wasn't valid when the write began stays stale.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { pointAtSql } from "./forkLabels.ts"
import { shownInSql } from "./forkState.ts"

const SELF = "self"
const FORK = "fork"
const SLOT = "slot"
const VERSION = "version"
const TEXT = "text"
const CHAT = "chat"
/** A fork's tip moved: `ref` the fork, `from` and `to` the tips. */
const TIP = "tip"
/** Every child of fork `ref`. */
const KIN = "kin"

/** Notes a touch: `kind`, the chat, the row it names and a sequence number (SQL expressions), when `when` holds. */
const touch = (kind: string, chat: string, ref = "NULL", seq = "NULL", when = "1") =>
  `INSERT INTO shell_touches (kind, chat_id, ref, seq) SELECT '${kind}', ${chat}, ${ref}, ${seq} WHERE ${when};`

/** The kinds of override a summary reads (baseline's shell_fork_overrides_* triggers). */
const READ_OVERRIDES = `('select', 'replace', 'delete_slot', 'insert', 'suppress_event')`

/** Placement, like selection, belongs to the fork's frozen lineage, including insert=0 at a new fork's base. */
const overrideTouch = (row: string) =>
  touch(FORK, `${row}.chat_id`, `${row}.fork_id`, `${row}.seq`, `${row}.kind IN ${READ_OVERRIDES}`)

const slotChat = (slot: string) => `(SELECT chat_id FROM slots WHERE id = ${slot})`

/** Bumped whenever the computation changes, so summaries stored by an older build are recomputed. */
// Valid per fork (fork_shell_stamps), not while the chat's stamp stays put.
export const FORK_SUMMARY_FORMAT = 10

/** SQL: whether summary row `s` was computed at or after its fork's last noted change. */
const afterForkSql = (s: string) =>
  `${s}.stamp >= coalesce((SELECT sv_f.stamp FROM fork_shell_stamps sv_f WHERE sv_f.fork_id = ${s}.fork_id), 0)`

/**
 * SQL: whether summary row `s` (a `fork_summaries` alias) of a fork of chat `c` (a `chats`
 * alias) is valid for an owner whose stamp is `userStamp` (an SQL expression): the current
 * format and owner stamp, and either computed at the chat's stamp now (nothing it reads has
 * changed since, noted or not), or computed at or after its fork's last noted change with every
 * move of the chat's stamp noted since.
 */
export const summaryValidSql = (s: string, c: string, userStamp: string) => `(${s}.format = ${FORK_SUMMARY_FORMAT}
  AND ${s}.user_stamp = ${userStamp} AND (${s}.stamp = ${c}.shell_stamp OR (${s}.stamp < ${c}.shell_stamp
  AND ${afterForkSql(s)}
  AND (SELECT sv_c.stamp FROM chat_shell_tracked sv_c WHERE sv_c.chat_id = ${c}.id) IS ${c}.shell_stamp)))`

const statements: ReadonlyArray<string> = [
  `CREATE TEMP TABLE IF NOT EXISTS shell_moved (chat_id TEXT PRIMARY KEY, stamp INTEGER NOT NULL)`,
  `CREATE TEMP TABLE IF NOT EXISTS shell_touches (kind TEXT NOT NULL, chat_id TEXT, ref TEXT, seq INTEGER,
    from_slot TEXT, to_slot TEXT)`,
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
  // Every new alternative contributes its cast and author, selected or not; human
  // alternatives also contribute persona activity.
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_version_insert AFTER INSERT ON main.versions
    WHEN EXISTS (SELECT 1 FROM slots WHERE id = NEW.slot_id)
    BEGIN ${touch(VERSION, slotChat("NEW.slot_id"), "NEW.id")} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_version AFTER UPDATE OF slot_id, speaker_entity_id, status, origin,
    source_version_id, created_at, deleted_at, purged_at, fork_id ON main.versions
    WHEN NEW.slot_id IS NOT OLD.slot_id OR NEW.speaker_entity_id IS NOT OLD.speaker_entity_id
      OR (NEW.status = 'failed') IS NOT (OLD.status = 'failed')
      OR NEW.origin IS NOT OLD.origin OR NEW.source_version_id IS NOT OLD.source_version_id
      OR NEW.created_at IS NOT OLD.created_at OR NEW.deleted_at IS NOT OLD.deleted_at
      OR NEW.purged_at IS NOT OLD.purged_at OR NEW.fork_id IS NOT OLD.fork_id
    BEGIN ${touch(SLOT, slotChat("OLD.slot_id"), "OLD.slot_id")} ${touch(SLOT, slotChat("NEW.slot_id"), "NEW.slot_id")} END`,
  // A single-fork import has no other summary to preserve; avoid walking its whole
  // newly pinned history. In a branched chat, pinning one file reaches only the forks
  // displaying those slots. `below` deduplicates their shared descendant paths.
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_version_text AFTER UPDATE OF content ON main.version_texts
    WHEN NEW.content IS NOT OLD.content BEGIN
      INSERT INTO shell_touches(kind, chat_id, ref)
        SELECT '${TEXT}', s.chat_id, v.id FROM versions v JOIN slots s ON s.id = v.slot_id
        WHERE v.seq = NEW.version_seq;
    END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_version_cast AFTER UPDATE OF cast_json, presence_json ON main.version_texts
    WHEN NEW.cast_json IS NOT OLD.cast_json OR NEW.presence_json IS NOT OLD.presence_json BEGIN
      INSERT INTO shell_touches(kind, chat_id, ref)
        SELECT CASE WHEN OLD.cast_json IS NULL AND (SELECT count(*) FROM (
          SELECT 1 FROM forks WHERE chat_id = s.chat_id LIMIT 2)) < 2
          THEN '${CHAT}' ELSE '${SLOT}' END, s.chat_id, s.id
        FROM versions v JOIN slots s ON s.id = v.slot_id WHERE v.seq = NEW.version_seq;
    END`,
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
  // removed in place, anywhere in the chat.
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
    deleted_at, purged_at ON main.forks
    BEGIN ${touch(SELF, "OLD.chat_id", "OLD.id")} ${touch(SELF, "NEW.chat_id", "NEW.id")}
    INSERT INTO shell_touches (kind, chat_id, ref, from_slot, to_slot) SELECT '${TIP}', NEW.chat_id, NEW.id,
      OLD.tip_slot_id, NEW.tip_slot_id WHERE OLD.tip_slot_id IS NOT NEW.tip_slot_id
        AND OLD.tip_slot_id IS NOT NULL AND NEW.tip_slot_id IS NOT NULL AND OLD.chat_id IS NEW.chat_id
        AND EXISTS (SELECT 1 FROM forks child WHERE child.parent_fork_id = NEW.id);
    ${touch(
      KIN,
      "OLD.chat_id",
      "OLD.id",
      "NULL",
      `OLD.chat_id IS NOT NEW.chat_id OR OLD.deleted_at IS NOT NEW.deleted_at
      OR OLD.purged_at IS NOT NEW.purged_at OR ((OLD.tip_slot_id IS NULL) <> (NEW.tip_slot_id IS NULL))`
    )} END`,
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_fork_delete AFTER DELETE ON main.forks
    BEGIN ${touch(SELF, "OLD.chat_id", "OLD.id")} ${touch(KIN, "OLD.chat_id", "OLD.id")} END`,
  // Starting threads changes which threads the branch they were started in is in. Forks made
  // from it earlier never see the split, and its new threads' forks are new (spec/THREADS.md §4.3).
  `CREATE TEMP TRIGGER IF NOT EXISTS shell_touch_thread_split AFTER INSERT ON main.thread_splits
    BEGIN ${touch(SELF, "NEW.chat_id", "NEW.fork_id")} END`
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
 * Moves the stamp of every fork of a chat this transaction's writes moved that they reach to
 * the chat's stamp now (every fork, where they can reach any, or where a move went unnoted),
 * notes the chat's stamp as tracked, and forgets the notes. Run inside the write's
 * transaction: at its end (`transaction` in tx.ts), and before a write computes summaries itself.
 */
export const settleSummaries = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    if (!tracking) return
    const moved = yield* sql<{ chat_id: string; stamp: number }>`SELECT chat_id, stamp FROM shell_moved`
    if (moved.length > 0) {
      // Resolve sparse touches before their versions: a covering index must not turn
      // settlement into a scan of every version in the database.
      // An alternative changes every fork's historical participation only when it
      // adds evidence. Its selection is already tracked by the fork override.
      // In particular, editing an old shared message must not walk every frozen
      // branch just to rediscover the same cast and human-author activity.
      yield* sql`INSERT INTO shell_touches(kind, chat_id, ref)
        SELECT DISTINCT ${SLOT}, t.chat_id, v.slot_id FROM shell_touches t
        CROSS JOIN versions v ON v.id = t.ref CROSS JOIN slots s ON s.id = v.slot_id
        WHERE t.kind = ${VERSION} AND v.purged_at IS NULL AND (
          EXISTS (SELECT 1 FROM version_participants p WHERE p.version_id = v.id AND NOT EXISTS (
            SELECT 1 FROM versions other JOIN version_participants op ON op.version_seq = other.seq
            WHERE other.slot_id = v.slot_id AND other.seq NOT IN (
              SELECT tv.seq FROM shell_touches tt CROSS JOIN versions tv ON tv.id = tt.ref
              WHERE tt.kind = ${VERSION}) AND other.purged_at IS NULL
              AND op.entity_id = p.entity_id))
          OR (s.inserted = 1 AND v.writer = 'human' AND v.speaker_entity_id IS NOT NULL))`
      // Decide once per moved chat. Inlining this scans all touches again for every
      // touched version below; pinning many swipes would make settlement quadratic.
      yield* sql`WITH RECURSIVE
        -- A chat whose stamp moved unnoted before this write is reached whole.
        kept(chat_id, stamp) AS MATERIALIZED (
          SELECT m.chat_id, m.stamp FROM shell_moved m
          WHERE (SELECT stamp FROM chat_shell_tracked WHERE chat_id = m.chat_id) = m.stamp AND NOT EXISTS (
            SELECT 1 FROM shell_touches t WHERE t.chat_id = m.chat_id AND (t.kind = ${CHAT}
              -- Only inserted slots can be shown off the structural path. A
              -- normal reply still reaches its forks by chain intervals even
              -- when another message in the chat has an insertion.
              OR (t.kind = ${SLOT} AND EXISTS (
                SELECT 1 FROM slots s WHERE s.id = t.ref AND s.inserted = 1))
              OR (t.kind = ${TEXT} AND EXISTS (
                SELECT 1 FROM versions v JOIN slots s ON s.id = v.slot_id WHERE v.id = t.ref AND s.inserted = 1))))),
        -- A shared old slot can have hundreds of thousands of descendants. Reach its
        -- forks by chain intervals, never by enumerating that message history. Deduplicate
        -- swipes pinned together before joining them to the forks' segments.
        -- Touches must drive the identity probes. With the planning covering index,
        -- an unconstrained join can instead scan every version on every write batch.
        touched(chat_id, chain_id, depth, author, at, slot_id, version_id) AS MATERIALIZED (
          SELECT DISTINCT s.chat_id, s.chain_id, s.depth, NULL, NULL, s.id, NULL
          FROM shell_touches t JOIN kept k ON k.chat_id = t.chat_id
            CROSS JOIN slots s ON s.id = t.ref WHERE t.kind = ${SLOT}
          UNION SELECT s.chat_id, s.chain_id, s.depth, v.speaker_entity_id,
            CASE WHEN v.origin IN ('edited', 'changeset') THEN s.created_at ELSE v.created_at END, s.id, NULL
          FROM shell_touches t JOIN kept k ON k.chat_id = t.chat_id CROSS JOIN versions v ON v.id = t.ref
            CROSS JOIN slots s ON s.id = v.slot_id
          WHERE t.kind = ${VERSION} AND v.writer = 'human' AND v.speaker_entity_id IS NOT NULL
            AND v.purged_at IS NULL AND s.inserted = 0
          UNION SELECT s.chat_id, s.chain_id, s.depth, NULL, NULL, s.id, v.id
          FROM shell_touches t JOIN kept k ON k.chat_id = t.chat_id CROSS JOIN versions v ON v.id = t.ref
            CROSS JOIN slots s ON s.id = v.slot_id WHERE t.kind = ${TEXT}),
        segments(fork_id, chat_id, chain_id, lo, hi) AS (
          SELECT f.id, f.chat_id, s.chain_id, h.depth, s.depth FROM kept k
            CROSS JOIN forks f ON f.chat_id = k.chat_id
            JOIN slots s ON s.id = f.tip_slot_id JOIN slots h ON h.id = s.chain_id
          WHERE EXISTS (SELECT 1 FROM touched t WHERE t.chat_id = k.chat_id)
          UNION ALL SELECT g.fork_id, g.chat_id, p.chain_id, h.depth, p.depth FROM segments g
            JOIN slots head ON head.id = g.chain_id JOIN slots p ON p.id = head.parent_slot_id
            JOIN slots h ON h.id = p.chain_id WHERE p.depth < g.lo AND h.depth <= p.depth),
        -- Each fork written once, from its lowest number (null: every fork whose lineage holds
        -- it), so the forks it reaches are found once per fork, not once per row it wrote.
        written(chat_id, ref, seq) AS (
          SELECT t.chat_id, t.ref, CASE WHEN count(t.seq) = count(*) THEN min(t.seq) END
          FROM shell_touches t JOIN kept k ON k.chat_id = t.chat_id WHERE t.kind = ${FORK} GROUP BY t.chat_id, t.ref),
        -- A tip's move, walked up from both ends to their common ancestor: the deeper end (both
        -- at one depth) of each pair is on one path and not the other.
        moved(fork, a, ad, b, bd) AS (
          SELECT t.ref, sa.id, sa.depth, sb.id, sb.depth FROM shell_touches t JOIN kept k ON k.chat_id = t.chat_id
            JOIN slots sa ON sa.id = t.from_slot JOIN slots sb ON sb.id = t.to_slot WHERE t.kind = ${TIP}
          UNION SELECT m.fork,
            CASE WHEN m.ad >= m.bd THEN pa.id ELSE m.a END, CASE WHEN m.ad >= m.bd THEN pa.depth ELSE m.ad END,
            CASE WHEN m.bd >= m.ad THEN pb.id ELSE m.b END, CASE WHEN m.bd >= m.ad THEN pb.depth ELSE m.bd END
          FROM moved m JOIN slots sa ON sa.id = m.a JOIN slots sb ON sb.id = m.b
            LEFT JOIN slots pa ON pa.id = sa.parent_slot_id AND pa.depth < sa.depth
            LEFT JOIN slots pb ON pb.id = sb.parent_slot_id AND pb.depth < sb.depth
          WHERE m.a <> m.b AND (m.ad < m.bd OR pa.id IS NOT NULL) AND (m.bd < m.ad OR pb.id IS NOT NULL)),
        shifted(fork, id) AS (
          SELECT fork, a FROM moved WHERE a <> b AND ad >= bd
          UNION SELECT fork, b FROM moved WHERE a <> b AND bd >= ad
          UNION SELECT h.fork, s.id FROM shifted h JOIN slots s ON s.parent_slot_id = h.id),
        reached(id) AS (
          SELECT t.ref FROM shell_touches t WHERE t.kind IN (${SELF}, ${FORK})
          -- Touches first, here and for the shifted slots below: the other order scanned every
          -- fork, probing the touches for each (300 ms of a 5,000-message rename's settlement).
          UNION ALL SELECT f.id FROM shell_touches t CROSS JOIN forks f ON f.parent_fork_id = t.ref
            WHERE t.kind = ${KIN} OR (t.kind = ${TIP} AND EXISTS (
              -- Moving to/from an inserted tip can change the display end.
              -- Normal structural tip moves use the shifted chain below.
              SELECT 1 FROM slots s WHERE s.id IN (t.from_slot, t.to_slot) AND s.inserted = 1))
          UNION ALL SELECT f.id FROM shifted h CROSS JOIN forks f ON f.parent_fork_id = h.fork AND f.tip_slot_id = h.id
          -- Once per segment, up to its first reaching touch: a bulk rewrite touches thousands
          -- of slots each segment holds, and pairing them all costs touches × forks.
          UNION ALL SELECT g.fork_id FROM segments g WHERE EXISTS (
            SELECT 1 FROM touched t JOIN slots affected ON affected.id = t.slot_id
            WHERE t.chat_id = g.chat_id AND t.chain_id = g.chain_id AND t.depth BETWEEN g.lo AND g.hi
            -- A newly human-authored alternative matters only when this fork
            -- doesn't already record that author's same or later turn.
            AND (t.version_id IS NULL OR ${sql.literal(shownInSql("g.fork_id", "affected"))} = t.version_id)
              -- Only a summary valid before this write can say the author's turn is recorded.
              AND (t.author IS NULL OR NOT EXISTS (
              SELECT 1 FROM fork_summaries fs, json_each(fs.activity_json) a WHERE fs.fork_id = g.fork_id
                AND fs.format = ${FORK_SUMMARY_FORMAT} AND ${sql.literal(afterForkSql("fs"))}
                AND fs.user_stamp = coalesce((SELECT u.stamp FROM chats ch JOIN shell_user_stamps u
                  ON u.user_id = ch.owner_user_id WHERE ch.id = fs.chat_id), 0)
                AND a.value ->> 'entityId' = t.author AND (a.value ->> 'at' > t.at
                  OR (a.value ->> 'at' = t.at AND a.value ->> 'slot' = t.slot_id)))))
          -- The writer's range from its point at that number: one range of fork_labels_point.
          UNION ALL SELECT x.fork_id FROM written w JOIN fork_labels wl ON wl.fork_id = w.ref
            JOIN fork_labels x ON x.chat_id = w.chat_id
              AND x.point >= CASE WHEN w.seq IS NULL THEN wl.base ELSE ${sql.literal(pointAtSql("w.ref", "w.seq"))} END
              AND x.point < wl.label_end)
        INSERT INTO fork_shell_stamps (fork_id, stamp)
        SELECT f.id, c.shell_stamp FROM shell_moved m JOIN chats c ON c.id = m.chat_id
          CROSS JOIN forks f ON f.chat_id = m.chat_id
        WHERE m.chat_id NOT IN (SELECT chat_id FROM kept) OR f.id IN (SELECT id FROM reached)
        ON CONFLICT (fork_id) DO UPDATE SET stamp = excluded.stamp`
      yield* sql`INSERT INTO chat_shell_tracked (chat_id, stamp)
        SELECT m.chat_id, c.shell_stamp FROM shell_moved m JOIN chats c ON c.id = m.chat_id WHERE 1
        ON CONFLICT (chat_id) DO UPDATE SET stamp = excluded.stamp`
      yield* sql`DELETE FROM shell_moved`
    }
    yield* sql`DELETE FROM shell_touches`
  })
