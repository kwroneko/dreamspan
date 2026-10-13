import { uuidv7 } from "@rp/shared/id.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

/** Zero effective content still needs immutable lineage, but never a provider request. */
export const completeEmpty = (
  sql: SqlClient.SqlClient,
  jobId: string,
  chatId: string,
  batchId: string | null,
  inputs: Summary["inputs"],
  children: ReadonlyArray<Summary> = [],
  level = children.length ? Math.max(...children.map((c) => c.level)) + 1 : 1
) =>
  Effect.gen(function* () {
    const id = uuidv7(),
      revision = uuidv7(),
      now = Date.now()
    const first = children[0]?.firstSlotId ?? inputs[0]!.slotId
    const last = children.at(-1)?.lastSlotId ?? inputs.at(-1)!.slotId
    yield* sql`INSERT INTO summary_revisions ${sql.insert({ id: revision, summary_id: id, content: "", token_count: 0, origin: "generated", created_at: now })}`
    yield* sql`INSERT INTO summaries ${sql.insert({
      id,
      chat_id: chatId,
      level,
      selected_revision_id: revision,
      first_slot_id: first,
      last_slot_id: last,
      slot_count: children.length ? children.reduce((n, c) => n + c.slotCount, 0) : inputs.length,
      status: "complete",
      batch_id: batchId,
      created_at: now
    })}`
    for (const [ordinal, input] of inputs.entries())
      yield* sql`INSERT INTO summary_inputs ${sql.insert({ summary_id: id, ordinal, slot_id: input.slotId, version_id: input.versionId, amend_count: input.amendCount })}`
    for (const [ordinal, child] of children.entries())
      yield* sql`INSERT INTO summary_parents ${sql.insert({ summary_id: id, ordinal, parent_id: child.id, parent_revision_id: child.revisionId })}`
    yield* sql`UPDATE summaries SET sealed=1 WHERE id=${id}`
    yield* sql`UPDATE summarization_jobs SET status='complete', result_summary_id=${id}, updated_at=${now} WHERE id=${jobId}`
  })
