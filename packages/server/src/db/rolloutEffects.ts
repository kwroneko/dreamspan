// A rollout's chat-state effects (spec/AGENTIC.md §4.3): a tool call's notes and state events,
// attached to the version being generated so they hold only while it's shown (a swipe reverses
// them), written with the call's receipt in one transaction. A call already receipted writes
// nothing again and answers with what it answered the first time: a resume re-runs it harmlessly.
import type { EntityId } from "@rp/shared/chat.ts"
import { NOTE_SCHEMA_VERSION } from "@rp/shared/docs/note.ts"
import type { Doc } from "@rp/shared/library.ts"
import type { StoredStateEventData } from "@rp/shared/state.ts"

type EventData = typeof StoredStateEventData.Type
import { Effect } from "effect"
import type { LibrarySteps } from "./editorWrites.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

/** A tool call's effects are told apart by their origin ref: `<rollout>:<tool call>`. */
export const effectRef = (rolloutId: string, toolCallId: string) => `${rolloutId}:${toolCallId}`

export const makeRolloutEffectHandlers = (steps: LibrarySteps) => {
  const { sql, drafts } = steps
  const graph = makeGraphWrites(sql, drafts)
  return {
    // Fallback for registered non-read tools whose work is not a single storage write.
    // Atomic built-ins already wrote their receipt and the first result wins here too.
    RecordRolloutEffects: ({ userId, rolloutId, toolCallId, result, isError, effects }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql<{ id: string }>`SELECT r.id FROM rollouts r JOIN chats c ON c.id = r.chat_id
        WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        const [prior] = yield* sql<{
          result_json: string
        }>`SELECT result_json FROM rollout_receipts WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
        if (prior) return JSON.parse(prior.result_json) as string
        yield* sql`INSERT OR IGNORE INTO rollout_receipts ${sql.insert({ rollout_id: rolloutId, tool_call_id: toolCallId, result_json: JSON.stringify(result), is_error: isError ? 1 : 0, created_at: Date.now() })}`
        for (const [seq, effect] of (effects ?? []).entries()) {
          yield* sql`INSERT INTO rollout_effects ${sql.insert({
            rollout_id: rolloutId,
            tool_call_id: toolCallId,
            seq,
            kind: effect.kind,
            target_kind: effect.targetKind,
            target_id: effect.targetId,
            title: effect.title,
            undo_json: effect.undo === null ? null : JSON.stringify(effect.undo),
            created_at: Date.now()
          })}`
        }
        const [row] = yield* sql<{
          result_json: string
        }>`SELECT result_json FROM rollout_receipts WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
        return JSON.parse(row!.result_json) as string
      }).pipe(transaction(sql, "RecordRolloutEffects")),
    ApplyRolloutEffect: ({ userId, rolloutId, toolCallId, events, notes, result }) =>
      Effect.gen(function* () {
        const [rollout] = yield* sql<{
          readonly chat_id: string
          readonly fork_id: string | null
          readonly version_id: string
          readonly slot_id: string
          readonly status: string
        }>`
          SELECT r.chat_id, r.fork_id, v.id AS version_id, v.slot_id, r.status
          FROM rollouts r JOIN chats c ON c.id = r.chat_id JOIN versions v ON v.rollout_id = r.id
          WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND v.deleted_at IS NULL
          ORDER BY (v.status = 'generating') DESC, v.created_at DESC, v.id DESC LIMIT 1`
        if (!rollout) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        const [receipt] = yield* sql<{ readonly result_json: string }>`
          SELECT result_json FROM rollout_receipts WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
        if (receipt) return { result: JSON.parse(receipt.result_json) as string, replayed: true }
        if (rollout.status !== "running" && rollout.status !== "created")
          return yield* new NotFound({ entity: "running rollout", id: rolloutId })
        const ref = effectRef(rolloutId, toolCallId)
        const written: Array<EventData> = []
        for (const write of notes ?? []) {
          if ("create" in write) {
            const doc: Doc = { ...write.create, owner: { chat: rollout.chat_id } }
            yield* steps.checkReferences(userId, doc)
            const note = yield* steps.createUpstream({
              userId,
              kind: "note",
              label: String(doc["title"] ?? "").slice(0, 200) || "Note",
              subtitle: "",
              doc: steps.encode(doc),
              schemaVersion: NOTE_SCHEMA_VERSION,
              origin: "generation",
              originRef: ref,
              sourcePath: null,
              sourceHash: null
            })
            written.push({ key: "note.activate", value: { note: note.entity_id as EntityId } })
          } else {
            const { note, parent, doc } = write.revise
            // The note must be the user's, and the parent one of its revisions.
            const [row] = yield* sql<{ readonly schema_version: number }>`
              SELECT r.schema_version FROM entity_revisions r JOIN entities e ON e.id = r.entity_id
              WHERE r.id = ${parent} AND e.id = ${note} AND e.kind = 'note'
                AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL`
            if (!row) return yield* new NotFound({ entity: "note", id: note })
            yield* steps.checkReferences(userId, doc)
            const revision = yield* steps.insertRevision({
              entityId: note,
              schemaVersion: row.schema_version,
              doc: steps.encode(doc),
              parents: [parent],
              origin: "generation",
              originRef: ref,
              message: "Changed by the agent"
            })
            written.push({ key: "note.binding", value: { note, revision: revision as never } })
          }
        }
        for (const data of [...written, ...events]) {
          yield* graph.insertStateEvent(
            userId,
            rollout.chat_id,
            rollout.slot_id,
            rollout.version_id,
            null,
            data,
            rollout.fork_id,
            { origin: "rollout", ref }
          )
        }
        yield* sql`INSERT INTO rollout_receipts ${sql.insert({
          rollout_id: rolloutId,
          tool_call_id: toolCallId,
          result_json: JSON.stringify(result),
          created_at: Date.now()
        })}`
        return { result, replayed: false }
      }).pipe(transaction(sql, "ApplyRolloutEffect"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
}
