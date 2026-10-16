import { Effect } from "effect"
import { fixtureSql } from "./lcmFixtures.ts"

export interface ImportGraphRow {
  readonly id: string
  readonly parent: string | null
  readonly selected: string
  readonly content: string
  readonly reasoning: string | null
  readonly at: number
  readonly origin: string
  readonly macroMode: string
  readonly status: string
}

/** An exhaustive snapshot, including deleted placeholders, through the existing fixture worker. */
export const stImportGraph = (dataDir: string, chatId: string) =>
  fixtureSql(
    dataDir,
    [
      {
        sql: `SELECT s.id, s.parent_slot_id AS parent, s.selected_version_id AS selected,
      v.content, v.reasoning, v.created_at AS at, v.origin, v.macro_mode AS macroMode, v.status
      FROM slots s JOIN versions v ON v.slot_id = s.id WHERE s.chat_id = ? ORDER BY s.depth, s.id, v.ordinal`,
        params: [chatId]
      }
    ],
    { readOnly: true }
  ).pipe(Effect.map(([rows]) => rows as unknown as ReadonlyArray<ImportGraphRow>))
