// Frozen scanning reference from 3a47fa35's parent. Only the settlement reach statement;
// kept independently so the differential test detects a changed reach set.
import type { SqlClient } from "effect/sql"
import { pointAtSql } from "../../src/db/forkLabels.ts"
import { shownInSql } from "../../src/db/forkState.ts"
const SLOT = "slot",
  VERSION = "version",
  TEXT = "text",
  CHAT = "chat",
  FORK = "fork",
  SELF = "self",
  KIN = "kin",
  TIP = "tip"
const FORK_SUMMARY_FORMAT = 10
const afterForkSql = (s: string) =>
  `${s}.stamp >= coalesce((SELECT sv_f.stamp FROM fork_shell_stamps sv_f WHERE sv_f.fork_id = ${s}.fork_id), 0)`
export const scanningSettlement = (sql: SqlClient.SqlClient) => sql`WITH RECURSIVE
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
        touched(chat_id, chain_id, depth, author, at, slot_id, version_id) AS MATERIALIZED (
          SELECT DISTINCT s.chat_id, s.chain_id, s.depth, NULL, NULL, s.id, NULL
          FROM shell_touches t CROSS JOIN kept k ON k.chat_id = t.chat_id
            CROSS JOIN slots s ON s.id = t.ref WHERE t.kind = ${SLOT}
          UNION SELECT s.chat_id, s.chain_id, s.depth, v.speaker_entity_id,
            CASE WHEN v.origin IN ('edited', 'changeset') THEN s.created_at ELSE v.created_at END, s.id, NULL
          FROM shell_touches t CROSS JOIN kept k ON k.chat_id = t.chat_id CROSS JOIN versions v ON v.id = t.ref
            CROSS JOIN slots s ON s.id = v.slot_id
          WHERE t.kind = ${VERSION} AND v.writer = 'human' AND v.speaker_entity_id IS NOT NULL
            AND v.purged_at IS NULL AND s.inserted = 0
          UNION SELECT s.chat_id, s.chain_id, s.depth, NULL, NULL, s.id, v.id
          FROM shell_touches t CROSS JOIN kept k ON k.chat_id = t.chat_id CROSS JOIN versions v ON v.id = t.ref
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
          UNION ALL SELECT f.id FROM shell_touches t JOIN forks f ON f.parent_fork_id = t.ref
            WHERE t.kind = ${KIN} OR (t.kind = ${TIP} AND EXISTS (
              -- Moving to/from an inserted tip can change the display end.
              -- Normal structural tip moves use the shifted chain below.
              SELECT 1 FROM slots s WHERE s.id IN (t.from_slot, t.to_slot) AND s.inserted = 1))
          UNION ALL SELECT f.id FROM shifted h JOIN forks f ON f.parent_fork_id = h.fork AND f.tip_slot_id = h.id
          UNION ALL SELECT g.fork_id FROM segments g JOIN touched t ON t.chat_id = g.chat_id
            AND t.chain_id = g.chain_id AND t.depth BETWEEN g.lo AND g.hi
            JOIN slots affected ON affected.id = t.slot_id
            -- A newly human-authored alternative matters only when this fork
            -- doesn't already record that author's same or later turn.
            WHERE (t.version_id IS NULL OR ${sql.literal(shownInSql("g.fork_id", "affected"))} = t.version_id)
              -- Only a summary valid before this write can say the author's turn is recorded.
              AND (t.author IS NULL OR NOT EXISTS (
              SELECT 1 FROM fork_summaries fs, json_each(fs.activity_json) a WHERE fs.fork_id = g.fork_id
                AND fs.format = ${FORK_SUMMARY_FORMAT} AND ${sql.literal(afterForkSql("fs"))}
                AND fs.user_stamp = coalesce((SELECT u.stamp FROM chats ch JOIN shell_user_stamps u
                  ON u.user_id = ch.owner_user_id WHERE ch.id = fs.chat_id), 0)
                AND a.value ->> 'entityId' = t.author AND (a.value ->> 'at' > t.at
                  OR (a.value ->> 'at' = t.at AND a.value ->> 'slot' = t.slot_id))))
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
