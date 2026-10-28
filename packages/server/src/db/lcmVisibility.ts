import type { SqlClient, Statement } from "effect/sql"
import { effectiveOverrideSql, withFork } from "./forkState.ts"

/** The immutable visibility inserted with a slot. LCM unhide is a fork override. */
export const contextExcluded = (alias = "s") => `${alias}.context_excluded`

/** SQL: whether slot `alias` is hidden from the model in the fork `fork` (an SQL expression): its `hide` row there, else as inserted (`contextExcluded`). */
const contextExcludedInSql = (fork: string, alias = "s") =>
  `coalesce((SELECT flag FROM fork_overrides WHERE id = ${effectiveOverrideSql("hide", fork, `${alias}.id`)}),
    ${contextExcluded(alias)})`

/** `contextExcludedInSql` for a fork bound as a parameter or given as a fragment. */
export const contextExcludedIn = (sql: SqlClient.SqlClient, fork: string | null | Statement.Fragment, alias = "s") =>
  withFork(sql, fork, (f) => contextExcludedInSql(f, alias))
