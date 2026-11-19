import { nextReceiptTime, pendingOperationReceipt, recoveredOperationText } from "./operationReceipts.ts"
// A rollout's chat-state effects (spec/AGENTIC.md §4.3): a tool call's notes and state events,
// attached to the version being generated so they hold only while it's shown (a swipe reverses
// them), written with the call's receipt in one transaction. A call already receipted writes
// nothing again and answers with what it answered the first time: a resume re-runs it harmlessly.
import type { ChatId, EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import { parsePresence, presenceOf } from "@dreamspan/shared/knowledge.ts"
import { NOTE_SCHEMA_VERSION } from "@dreamspan/shared/docs/note.ts"
import type { Doc } from "@dreamspan/shared/library.ts"
import { type FoldableEvent, foldState, type StoredStateEventData } from "@dreamspan/shared/state.ts"

type EventData = typeof StoredStateEventData.Type
import { Effect } from "effect"
import type { LibrarySteps } from "./editorWrites.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { presenceJson } from "./participation.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { withoutPurged } from "./stateRefs.ts"
import { transaction } from "./tx.ts"

/** A tool call's effects are told apart by their origin ref: `<rollout>:<tool call>`. */
export const effectRef = (rolloutId: string, toolCallId: string) => `${rolloutId}:${toolCallId}`

export const makeRolloutEffectHandlers = (steps: LibrarySteps) => {
  const { sql, drafts } = steps
  const graph = makeGraphWrites(sql, drafts)
  return {
    // Fallback for registered non-read tools whose work is not a single storage write.
    // Atomic built-ins already wrote their receipt and the first result wins here too.
    RecordRolloutEffects: ({ userId, rolloutId, toolCallId, result, isError, effects, completeOperation }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql<{ id: string }>`SELECT r.id FROM rollouts r JOIN chats c ON c.id = r.chat_id
        WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        const [prior] = yield* sql<{
          result_json: string
        }>`SELECT result_json FROM rollout_receipts WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
        if (prior) {
          const text: unknown = JSON.parse(prior.result_json)
          if (completeOperation && pendingOperationReceipt(text)) {
            yield* sql`UPDATE rollout_receipts SET result_json = ${JSON.stringify(result)}, is_error = ${isError ? 1 : 0}
              WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
            return result
          }
          return typeof text === "string" ? text : recoveredOperationText(text)
        }
        const at = yield* nextReceiptTime(sql, rolloutId)
        yield* sql`INSERT OR IGNORE INTO rollout_receipts ${sql.insert({ rollout_id: rolloutId, tool_call_id: toolCallId, result_json: JSON.stringify(result), is_error: isError ? 1 : 0, created_at: at })}`
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
            created_at: at
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
          FROM rollouts r JOIN chats c ON c.id = r.chat_id
          -- A subagent's state is its reply's (spec/SUBAGENTS.md §8): attached to that version.
          JOIN versions v ON v.rollout_id = coalesce(r.spawned_by_rollout_id, r.id)
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
      }).pipe(transaction(sql, "ApplyRolloutEffect")),
    DeclareRolloutPresence: ({ userId, rolloutId, toolCallId, present }) =>
      Effect.gen(function* () {
        const [rollout] = yield* sql<{
          readonly chat_id: string
          readonly fork_id: string | null
          readonly leaf_slot_id: string | null
          readonly version_id: string
          readonly slot_id: string
          readonly status: string
          readonly speaker: string | null
          readonly cast_json: string | null
          readonly presence_json: string | null
        }>`
          SELECT r.chat_id, r.fork_id, r.leaf_slot_id, v.id AS version_id, v.slot_id, r.status,
            v.speaker_entity_id AS speaker, v.cast_json, v.presence_json
          FROM rollouts r JOIN chats c ON c.id = r.chat_id JOIN version_records v ON v.rollout_id = r.id
          WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND v.deleted_at IS NULL
          ORDER BY (v.status = 'generating') DESC, v.created_at DESC, v.id DESC LIMIT 1`
        if (!rollout) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        const [receipt] = yield* sql<{ readonly result_json: string }>`
          SELECT result_json FROM rollout_receipts WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
        if (receipt) return { left: [], back: [], replayed: true }
        if (rollout.status !== "running" && rollout.status !== "created")
          return yield* new NotFound({ entity: "running rollout", id: rolloutId })
        // The cast the message was assembled with: nobody else can be said to be there.
        const cast = rollout.cast_json === null ? [] : (JSON.parse(rollout.cast_json) as ReadonlyArray<string>)
        const stranger = present.find((id) => !cast.includes(id))
        if (stranger !== undefined) return yield* new NotFound({ entity: "cast member", id: stranger })
        // The state the message was assembled from (its parent), in its fork.
        const state = foldState(
          yield* withoutPurged(
            sql,
            (yield* stateEventsThrough(
              sql,
              rollout.chat_id as ChatId,
              rollout.leaf_slot_id as SlotId | null,
              rollout.fork_id
            )).map((e) => ({
              scope: e.scope,
              data: { key: e.key, value: JSON.parse(e.value_json) }
            })) as Array<FoldableEvent>
          )
        )
        // Where this run's earlier calls left each character (`set_presence` before the send):
        // what the next message would start from if nothing were said here.
        const own = yield* sql<{ readonly value_json: string }>`
          SELECT value_json FROM state_events
          WHERE version_id = ${rollout.version_id} AND key = 'away.set' AND superseded_by_changeset IS NULL
          ORDER BY seq`
        const standing = new Set<string>(state.away)
        for (const row of own) {
          const value = JSON.parse(row.value_json) as { readonly entity: string; readonly away: boolean }
          if (value.away) standing.add(value.entity)
          else standing.delete(value.entity)
        }
        const recorded = parsePresence(rollout.presence_json)
        const wasAway = new Set<string>(recorded?.away ?? [])
        const said = new Set<string>(present)
        // Said: the characters the model speaks for. A narrator is never in or out of the scene,
        // a card the user plays stays as the message recorded it, and the speaker is there for
        // its own message.
        const narrator = (id: string) => state.roles[id] === "narrator"
        const awayNow = (id: string) =>
          narrator(id) || id === rollout.speaker
            ? false
            : state.playedByMe.includes(id)
              ? wasAway.has(id)
              : !said.has(id)
        const next = presenceOf({ away: cast.filter(awayNow), roles: state.roles }, cast)
        if (presenceJson(next) !== presenceJson(recorded))
          yield* sql`UPDATE version_records SET presence_json = ${presenceJson(next)} WHERE id = ${rollout.version_id}`
        const ref = effectRef(rolloutId, toolCallId)
        const left: Array<EntityId> = []
        const back: Array<EntityId> = []
        for (const id of cast) {
          if (narrator(id) || (state.playedByMe.includes(id) && id !== rollout.speaker)) continue
          const after = awayNow(id)
          if (standing.has(id) === after) continue
          ;(after ? left : back).push(id as EntityId)
          yield* graph.insertStateEvent(
            userId,
            rollout.chat_id,
            rollout.slot_id,
            rollout.version_id,
            null,
            { key: "away.set", value: { entity: id as EntityId, away: after } },
            rollout.fork_id,
            { origin: "rollout", ref }
          )
        }
        yield* sql`INSERT INTO rollout_receipts ${sql.insert({
          rollout_id: rolloutId,
          tool_call_id: toolCallId,
          result_json: JSON.stringify("Sent."),
          created_at: Date.now()
        })}`
        return { left, back, replayed: false }
      }).pipe(transaction(sql, "DeclareRolloutPresence"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
}
