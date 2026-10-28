import type { SqlClient } from "effect/sql"
import { effectiveOverrideSql, withFork } from "./forkState.ts"

/** A staged unhide takes effect with its run's single publication. Explicit later visibility
 * edits clear the overlay, so users can hide those messages again. */
export const contextExcluded = (alias = "s") => `CASE WHEN ${alias}.context_excluded = 1 AND EXISTS (
  SELECT 1 FROM lcm_enable_slots es JOIN lcm_enable_runs er ON er.id = es.run_id
  WHERE es.slot_id = ${alias}.id AND es.shown = 1 AND er.published = 1
) THEN 0 ELSE ${alias}.context_excluded END`

/** SQL: whether slot `alias` is hidden from the model in the fork `fork` (an SQL expression): its `hide` row there, else as inserted (`contextExcluded`). */
const contextExcludedInSql = (fork: string, alias = "s") =>
  `coalesce((SELECT flag FROM fork_overrides WHERE id = ${effectiveOverrideSql("hide", fork, `${alias}.id`)}),
    ${contextExcluded(alias)})`

/** `contextExcludedInSql` for a fork bound as a parameter or given as a fragment. */
export const contextExcludedIn = (sql: SqlClient.SqlClient, fork: string | null, alias = "s") =>
  withFork(sql, fork, (f) => contextExcludedInSql(f, alias))
