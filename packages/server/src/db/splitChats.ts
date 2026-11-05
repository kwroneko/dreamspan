import type { SqlClient } from "effect/sql"
import { Effect } from "effect"

const PREFIX = "split-chat:"
export const splitChatKey = (fork: string) => `${PREFIX}${fork}`

export const splitChatMarkers = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.map(
    sql<{ key: string }>`SELECT key FROM user_settings WHERE user_id = ${userId}
      AND key GLOB 'split-chat:*' AND value_json = 'true'`,
    (rows) => new Set(rows.map((r) => r.key.slice(PREFIX.length)))
  )

/** Nearest marked ancestor, including the branch itself. Iterative for deeply nested trees. */
export const splitGroups = (
  forks: ReadonlyArray<{
    readonly id: string
    readonly chat_id: string
    readonly parent_fork_id: string | null
    readonly deleted_at?: number | null
  }>,
  markers: ReadonlySet<string>
) => {
  const byId = new Map(forks.map((f) => [f.id, f]))
  const groups = new Map<string, string>()
  for (const fork of forks) {
    const path: Array<string> = []
    let next = fork
    let group = fork.chat_id
    while (true) {
      const known = groups.get(next.id)
      if (known !== undefined) {
        group = known
        break
      }
      if (markers.has(next.id) && next.deleted_at == null) {
        group = next.id
        break
      }
      path.push(next.id)
      const parent = next.parent_fork_id === null ? undefined : byId.get(next.parent_fork_id)
      if (!parent) break
      next = parent
    }
    for (const id of path) groups.set(id, group)
    groups.set(fork.id, group)
  }
  return groups
}
