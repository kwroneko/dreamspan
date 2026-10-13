// Summaries written by fixtures into a running server's database, as the summarizer would
// have (ARCHITECTURE §16): the browser tests need them, and no model is asked. The rows
// follow the triggers' rules, so a malformed fixture fails here, not silently in the UI.
import { Effect } from "effect"
import type { ChatId, PathEntry } from "@rp/shared/chat.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { fixtureSql } from "../../../server/test/support/lcmFixtures.ts"

export interface FixtureSummary {
  readonly id: string
  readonly revisionId: string
  readonly firstSlotId: string
  readonly lastSlotId: string
  readonly slotCount: number
  readonly level: number
}

const run = (dataDir: string, statements: Parameters<typeof fixtureSql>[1]) =>
  Effect.runPromise(fixtureSql(dataDir, statements))

/** A level-1 summary over these entries, each as its slot's selected version. */
export const level1 = async (
  dataDir: string,
  chatId: ChatId,
  entries: ReadonlyArray<PathEntry>,
  content: string,
  options: { readonly status?: "complete" | "failed" } = {}
): Promise<FixtureSummary> => {
  const id = uuidv7()
  const revisionId = uuidv7()
  await run(dataDir, [
    {
      sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?,?,?, 'generated',?)",
      params: [revisionId, id, content, Math.ceil(content.length / 4), Date.now()]
    },
    {
      sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,error_json,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)",
      params: [
        id,
        chatId,
        revisionId,
        entries[0]!.slotId,
        entries.at(-1)!.slotId,
        entries.length,
        options.status ?? "complete",
        options.status === "failed" ? JSON.stringify({ class: "refusal", message: "refused" }) : null,
        Date.now()
      ]
    },
    ...entries.map((entry, ordinal) => ({
      sql: "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id,amend_count) VALUES(?,?,?,?,0)",
      params: [id, ordinal, entry.slotId, entry.version.id]
    })),
    { sql: "UPDATE summaries SET sealed=1 WHERE id=?", params: [id] }
  ])
  return {
    id,
    revisionId,
    firstSlotId: entries[0]!.slotId,
    lastSlotId: entries.at(-1)!.slotId,
    slotCount: entries.length,
    level: 1
  }
}

/** A summary over these summaries, in order. */
export const condensed = async (
  dataDir: string,
  chatId: ChatId,
  children: ReadonlyArray<FixtureSummary>,
  content: string
): Promise<FixtureSummary> => {
  const id = uuidv7()
  const revisionId = uuidv7()
  const level = Math.max(...children.map((c) => c.level)) + 1
  const slotCount = children.reduce((n, c) => n + c.slotCount, 0)
  await run(dataDir, [
    {
      sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?,?,?, 'generated',?)",
      params: [revisionId, id, content, Math.ceil(content.length / 4), Date.now()]
    },
    {
      sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,created_at) VALUES(?,?,?,?,?,?,?,'complete',?)",
      params: [
        id,
        chatId,
        level,
        revisionId,
        children[0]!.firstSlotId,
        children.at(-1)!.lastSlotId,
        slotCount,
        Date.now()
      ]
    },
    ...children.map((child, ordinal) => ({
      sql: "INSERT INTO summary_parents(summary_id,ordinal,parent_id,parent_revision_id) VALUES(?,?,?,?)",
      params: [id, ordinal, child.id, child.revisionId]
    })),
    { sql: "UPDATE summaries SET sealed=1 WHERE id=?", params: [id] }
  ])
  return {
    id,
    revisionId,
    firstSlotId: children[0]!.firstSlotId,
    lastSlotId: children.at(-1)!.lastSlotId,
    slotCount,
    level
  }
}

/** A job that gave up on these entries, as the summarizer leaves one after its retries. */
export const failedJob = async (dataDir: string, chatId: ChatId, entries: ReadonlyArray<PathEntry>, error: string) => {
  const id = uuidv7()
  await run(dataDir, [
    {
      sql: "INSERT INTO summarization_jobs(id,chat_id,level,first_slot_id,last_slot_id,status,target_token_count,error,created_at,updated_at) VALUES(?,?,1,?,?,'failed',600,?,1,1)",
      params: [id, chatId, entries[0]!.slotId, entries.at(-1)!.slotId, error]
    }
  ])
  return id
}

export const count = async (dataDir: string, table: string) => {
  const [rows] = await run(dataDir, [{ sql: `SELECT count(*) AS n FROM ${table}` }])
  return rows![0]!["n"] as number
}
