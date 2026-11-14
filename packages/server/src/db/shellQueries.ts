import { effectiveOverrideSql, eventAppliesSql, eventOrder, shownInSql, slotDeletedInSql } from "./forkState.ts"
import { lineageCte } from "./forkLabels.ts"
import { slotHumanAuthorsSql, slotParticipantsSql } from "./participation.ts"

// Shared with query-plan regressions. Both take the forks to summarize as a JSON array of ids
// (db/forkSummaries.ts), the user's own: only forks whose summaries are stale are read. Every projection names the actual live fork;
// neither a physical leaf nor a tip shared by several forks identifies a view.
// Check for overrides once per view; untouched chats use the base selection and
// deletion columns without per-message lineage lookups.
const slotsQuery = (evidence: boolean) => `WITH RECURSIVE views AS MATERIALIZED (
  SELECT f.id AS fork_id, c.id AS chat_id, f.tip_slot_id, label.point,
    EXISTS(SELECT 1 FROM fork_overrides o WHERE o.chat_id = c.id) AS has_overrides
  FROM json_each(?) j CROSS JOIN forks f ON f.id = j.value CROSS JOIN chats c ON c.id = f.chat_id
  LEFT JOIN fork_labels label ON label.fork_id = f.id
  WHERE c.deleted_at IS NULL AND f.deleted_at IS NULL
), segments(fork_id, chat_id, chain_id, lo, hi, has_overrides, point) AS (
  SELECT f.fork_id, f.chat_id, t.chain_id, h.depth, t.depth, f.has_overrides, f.point
  FROM views f JOIN slots t ON t.id = f.tip_slot_id JOIN slots h ON h.id = t.chain_id
  UNION ALL
  SELECT g.fork_id, g.chat_id, p.chain_id, ph.depth, p.depth, g.has_overrides, g.point
  FROM segments g JOIN slots h ON h.id = g.chain_id JOIN slots p ON p.id = h.parent_slot_id
  JOIN slots ph ON ph.id = p.chain_id WHERE p.depth < g.lo AND ph.depth <= p.depth
)
SELECT g.fork_id, s.id, s.depth, s.chat_id, s.parent_slot_id,
  s.created_at, CASE WHEN CASE WHEN g.has_overrides THEN ${slotDeletedInSql("g.fork_id", "s", "g.point")}
    ELSE s.deleted_at IS NOT NULL OR s.purged_at IS NOT NULL END THEN 1 END AS deleted_at,
  v.status, v.speaker_entity_id AS speaker, CASE WHEN v.origin IN ('edited', 'changeset') THEN s.created_at ELSE v.created_at END AS at,
  v.seq AS version_seq, v.content_length, ${evidence ? slotParticipantsSql("s") : "'[]'"} AS participants, ${evidence ? slotHumanAuthorsSql("s") : "'[]'"} AS human_authors
  FROM segments g CROSS JOIN slots s ON s.chat_id = g.chat_id AND s.chain_id = g.chain_id AND s.depth BETWEEN g.lo AND g.hi
  LEFT JOIN fork_overrides shell_selection ON shell_selection.id = CASE WHEN g.has_overrides
    THEN ${effectiveOverrideSql("select", "g.fork_id", "s.id", "g.point")} END
  LEFT JOIN fork_overrides shell_replacement ON shell_replacement.id = CASE WHEN g.has_overrides
    THEN ${effectiveOverrideSql("replace", "g.fork_id", "coalesce(shell_selection.value_id, s.selected_version_id)", "g.point")} END
  JOIN versions v ON v.slot_id = s.id
    AND v.id = coalesce(shell_replacement.value_id, shell_selection.value_id, s.selected_version_id)
  ORDER BY s.depth, s.id`

export const shellSlotsQuery = slotsQuery(true)
/** Split markers/previews never consume historical participation or human-author activity. */
export const shellOutlineSlotsQuery = slotsQuery(false)

export const shellEventsQuery = `SELECT f.id AS fork_id, e.fork_id AS source_fork_id, e.chat_id, e.slot_id, e.scope, e.key, e.value_json
  FROM json_each(?) j CROSS JOIN forks f ON f.id = j.value CROSS JOIN chats c ON c.id = f.chat_id
  CROSS JOIN state_events e ON e.chat_id = c.id
  LEFT JOIN slots s ON s.id = e.slot_id
  WHERE c.deleted_at IS NULL AND f.deleted_at IS NULL
    AND ${eventAppliesSql("f.id", "e")}
    AND (e.slot_id IS NULL OR NOT ${slotDeletedInSql("f.id", "s")})
    AND (e.version_id IS NULL OR e.version_id = ${shownInSql("f.id", "s")}
      OR e.version_id = coalesce((SELECT value_id FROM fork_overrides
        WHERE id = ${effectiveOverrideSql("select", "f.id", "s.id")}), s.selected_version_id))
  ORDER BY ${eventOrder("e")}`

/**
 * Of the forks given (a JSON array of ids), the ones nothing in their lineage selects, replaces
 * or deletes a message for: each of their slots shows what `shellSlotsQuery` reads for a chat
 * without overrides, its own columns, whichever of them it is on the path of. The lineage is
 * walked by parent (`lineageCte`), stopping at the first entry with such a row.
 */
export const shellPlainForksQuery = `SELECT f.id FROM json_each(?) j CROSS JOIN forks f ON f.id = j.value
  WHERE NOT EXISTS (
    WITH RECURSIVE ${lineageCte("lineage", "f.id")}
    SELECT 1 FROM lineage l CROSS JOIN fork_overrides o
    WHERE o.fork_id = l.fork_id AND o.kind IN ('select', 'replace', 'delete_slot') AND o.seq <= l.bound)`

/**
 * Every slot of the chats given (a JSON array of ids) as `shellSlotsQuery` reads it for a fork
 * of `shellPlainForksQuery`'s: the chat's tree once, for all such forks to walk their paths in.
 * Since perfshell2 the shell reads trees through db/forkPaths.ts instead; this and
 * `shellPlainForksQuery` remain for the plan and classification tests that pin their behavior.
 */
export const shellTreeQuery = `SELECT NULL AS fork_id, s.id, s.depth, s.chat_id, s.parent_slot_id, s.created_at,
  CASE WHEN s.deleted_at IS NOT NULL OR s.purged_at IS NOT NULL THEN 1 END AS deleted_at,
  v.status, v.speaker_entity_id AS speaker, CASE WHEN v.origin IN ('edited', 'changeset') THEN s.created_at ELSE v.created_at END AS at,
  v.seq AS version_seq, v.content_length, ${slotParticipantsSql("s")} AS participants, ${slotHumanAuthorsSql("s")} AS human_authors
  FROM json_each(?) j CROSS JOIN slots s ON s.chat_id = j.value JOIN versions v ON v.slot_id = s.id AND v.id = s.selected_version_id`
