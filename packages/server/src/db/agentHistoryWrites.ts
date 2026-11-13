import { checkStoryWrite } from "./storyWriteScope.ts"
import { displaySlots } from "./displayPath.ts"
import { Effect, Schema } from "effect"
import { uuidv7 } from "@rp/shared/id.ts"
import { HistoryRejected, type HistoryEdit } from "@rp/shared/historyApi.ts"
import { FoldableEvent } from "@rp/shared/state.ts"
import { EffectUndoRefused } from "@rp/shared/workshopApi.ts"
import type { ChatId, ForkId, StoryAt } from "@rp/shared/chat.ts"
import type { LibrarySteps } from "./editorWrites.ts"
import type { makeHistoryWriteHandlers } from "./historyWrites.ts"
import type { WriteOps } from "./ops.ts"
import { agentHistorySnapshot, checkWorkshopAccess, rewriteFork, type WorkshopCall } from "./agentHistoryShared.ts"
import { selectedIn, nextSeq } from "./forkState.ts"
import { transaction } from "./tx.ts"
import { nextReceiptTime } from "./operationReceipts.ts"
import { workshopLimits } from "../workshopLimits.ts"

const reject = (message: string) => new HistoryRejected({ message })
const instructionKeys = new Set([
  "note.binding",
  "preset.binding",
  "preset.unbind",
  "lorebook.attach",
  "lorebook.detach",
  "lorebook.remove"
])

export const makeAgentHistoryWriteHandlers = (
  steps: LibrarySteps,
  history: Effect.Success<typeof makeHistoryWriteHandlers>
) => {
  const { sql } = steps
  const startEdit = Effect.fnUntraced(function* (
    input: WorkshopCall & { chatId: ChatId; forkId: ForkId; storyAt?: StoryAt }
  ) {
    const source = yield* checkWorkshopAccess(sql, input, "chats.rewrite")
    const fork = yield* rewriteFork(sql, input.userId, input.chatId, input.forkId)
    const position = yield* checkStoryWrite(sql, input.userId, input.rolloutId, input.chatId, input.storyAt)
    if (position && input.forkId !== input.storyAt!.forkId)
      return yield* reject("This edit names another story branch.")
    const leaf = position ? input.storyAt!.leafSlotId : fork.tip_slot_id
    const id = uuidv7()
    const at = Date.now()
    const [message] = yield* sql<{
      id: string
      slot_id: string
    }>`SELECT id,slot_id FROM versions WHERE rollout_id=${input.rolloutId}
      ORDER BY (status='generating') DESC,created_at DESC,id DESC LIMIT 1`
    yield* sql`INSERT INTO rollouts(id,chat_id,fork_id,kind,status,role,request_class,leaf_slot_id,created_at,started_at,updated_at,completed_at)
      VALUES (${id},${input.chatId},${input.forkId},'edit','completed','assistant','interactive',${leaf},${at},${at},${at},${at})`
    yield* sql`INSERT INTO rollout_payloads(rollout_id,context_snapshot_json) VALUES (${id},${JSON.stringify({ workshop: { chat: source.chat_id, rollout: input.rolloutId, toolCall: input.toolCallId, version: message?.id ?? null, slot: message?.slot_id ?? null } })})`
    return id
  })
  return {
    StartEditRollout: (input) => startEdit(input).pipe(transaction(sql, "StartEditRollout")),
    ApplyAgentChangeset: (input) =>
      Effect.gen(function* () {
        // Check ownership before returning a durable result, even after the run has ended.
        const [owned] = yield* sql`SELECT 1 FROM rollouts r JOIN chats c ON c.id=r.chat_id WHERE r.id=${input.rolloutId}
        AND c.owner_user_id=${input.userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* reject("That workshop run is unavailable.")
        const [receipt] = yield* sql<{
          result_json: string
        }>`SELECT result_json FROM rollout_receipts WHERE rollout_id=${input.rolloutId} AND tool_call_id=${input.toolCallId}`
        if (receipt) return JSON.parse(receipt.result_json) as string
        yield* checkWorkshopAccess(sql, input, "chats.rewrite")
        const position = yield* checkStoryWrite(sql, input.userId, input.rolloutId, input.chatId, input.storyAt)
        let range: { first: number; last: number } | undefined
        if (position) {
          if (input.forkId !== input.storyAt!.forkId)
            return yield* reject("This change names another branch. Send the request again.")
          if (
            input.edits.some(
              (edit) =>
                edit.kind === "state_event" &&
                (edit.targetId || edit.atSlotId !== (input.storyAt!.leafSlotId ?? undefined))
            )
          )
            return yield* reject("Instruction changes must start at the story tab’s position.")
          // One set-based check for the whole rewrite, including summary endpoints and
          // inserted messages. Never walk a thousands-message path once per edited text.
          const [bounds] = yield* sql<{ invalid: number; first: number | null; last: number | null }>`
            ${displaySlots(sql, position.pieces, 0, position.upTo - 1)}
            SELECT coalesce(sum(CASE WHEN w.value ->> '$.kind'='version_replace' THEN d.id IS NULL
              ELSE a.id IS NULL OR b.id IS NULL END),0) AS invalid,
              min(coalesce(d.position,a.position))+1 AS first,max(coalesce(d.position,b.position))+1 AS last
            FROM json_each(${JSON.stringify(input.edits)}) w
            LEFT JOIN versions v ON w.value ->> '$.kind'='version_replace' AND v.id=w.value ->> '$.targetId'
            LEFT JOIN summaries s ON w.value ->> '$.kind'='summary_revision' AND s.id=w.value ->> '$.targetId' AND s.chat_id=${input.chatId}
            LEFT JOIN display_slots d ON d.id=v.slot_id
            LEFT JOIN display_slots a ON a.id=s.first_slot_id
            LEFT JOIN display_slots b ON b.id=s.last_slot_id
            WHERE w.value ->> '$.kind'<>'state_event'`
          if (bounds!.invalid) return yield* reject("Choose texts at or before the story tab’s position.")
          const instructions = input.notes?.length || input.edits.some((e) => e.kind === "state_event")
          range = {
            first: bounds!.first ?? position.upTo,
            last: instructions ? position.upTo : (bounds!.last ?? position.upTo)
          }
        }
        const items = input.edits.length + (input.notes?.length ?? 0)
        if (items > workshopLimits.rewriteItems || items === 0)
          return yield* reject(
            `One rewrite can change at most ${workshopLimits.rewriteItems} texts or bindings. Narrow this rewrite.`
          )
        const [running] =
          yield* sql`SELECT 1 FROM versions v JOIN slots s ON s.id=v.slot_id WHERE s.chat_id=${input.chatId} AND v.status='generating' LIMIT 1`
        if (running) return yield* reject("That chat is writing a reply; try again when it's done.")
        const snapshot = yield* agentHistorySnapshot(sql, input.userId, input.chatId, input.forkId)
        if (snapshot.stamp !== input.expected)
          return yield* reject("That chat changed since this rewrite was prepared. Read it again and ask again.")
        const bytes =
          input.edits.reduce((n, e) => n + Buffer.byteLength(e.after, "utf8"), 0) +
          (input.notes ?? []).reduce((n, e) => n + Buffer.byteLength(e.text, "utf8"), 0)
        if (bytes > 262144) return yield* reject("One rewrite can write at most 262,144 bytes. Rewrite fewer messages.")
        // Count durable output, including undone rewrites: Undo never replenishes a run's allowance.
        const [used] = yield* sql<{
          n: number
          calls: number
        }>`SELECT coalesce(sum(json_extract(undo_json,'$.bytes')),0) AS n,
          (SELECT count(*) FROM rollout_receipts WHERE rollout_id=${input.rolloutId}) AS calls FROM rollout_effects
        WHERE rollout_id=${input.rolloutId} AND kind='changeset.apply'`
        if (used!.n + bytes > 1048576 || used!.calls >= workshopLimits.calls)
          return yield* new EffectUndoRefused({
            message: "This run reached its rewrite limit. Start another turn to continue."
          })
        for (const expected of input.expectedRefs ?? []) {
          const ref = yield* steps.lib.ownedRef(input.userId, expected.refId)
          if (ref.row_version !== expected.rowVersion)
            return yield* reject("An instruction's library item changed while waiting. Read it again and ask again.")
        }
        const edits: HistoryEdit[] = [...input.edits]
        if (!input.includeSwipes) {
          const [unshown] =
            yield* sql`SELECT 1 FROM json_each(${JSON.stringify(edits.filter((e) => e.kind === "version_replace").map((e) => e.targetId))}) wanted
            LEFT JOIN versions o ON o.id=wanted.value LEFT JOIN slots s ON s.id=o.slot_id
            WHERE o.id IS NULL OR o.id IS NOT ${selectedIn(sql, input.forkId, "s")} LIMIT 1`
          if (unshown) return yield* reject("An unshown swipe was not included in this rewrite.")
        }
        for (const edit of edits) {
          if (edit.kind === "state_event") {
            const event = yield* Schema.decodeUnknownEffect(FoldableEvent)(
              yield* Effect.try({ try: () => JSON.parse(edit.after), catch: () => reject("Invalid instruction JSON.") })
            ).pipe(Effect.mapError(() => reject("Invalid instruction change.")))
            if (edit.targetId) {
              const [old] = yield* sql<{
                key: string
              }>`SELECT key FROM state_events WHERE id=${edit.targetId} AND chat_id=${input.chatId}`
              if (!old || !instructionKeys.has(old.key))
                return yield* reject("That state item cannot be rewritten by this tool.")
            }
            if (!instructionKeys.has(event.data.key))
              return yield* reject("This instruction change is not exposed to tools.")
          }
        }
        for (const note of input.notes ?? []) {
          const ref = yield* steps.lib.ownedRef(input.userId, note.refId)
          const [parent] =
            yield* sql`SELECT 1 FROM entity_revisions WHERE id=${note.parent} AND entity_id=${ref.entity_id}`
          if (!parent) return yield* reject("That note revision is unavailable.")
          const doc = yield* steps.lib.loadDoc(note.parent)
          if (
            typeof doc.link === "string" ||
            ref.kind !== "note" ||
            (doc.owner as { chat?: string })?.chat !== input.chatId ||
            ref.row_version !== note.expectedRowVersion
          )
            return yield* reject("That chat note changed or is not owned by this chat. Read it again.")
          const revision = yield* steps.insertRevision({
            entityId: ref.entity_id,
            schemaVersion: (yield* steps.revision(ref.head_revision_id)).schema_version,
            doc: steps.encode({ ...doc, content: note.text }),
            parents: [note.parent],
            origin: "agent",
            originRef: `${input.rolloutId}:${input.toolCallId}`,
            message: input.title
          })
          edits.push({
            kind: "state_event",
            targetId: "",
            beforeId: "",
            before: "",
            after: JSON.stringify({
              scope: null,
              data: { key: "note.binding", value: { note: ref.entity_id, revision } }
            }),
            ...((input.storyAt ? input.storyAt.leafSlotId : snapshot.leaf)
              ? { atSlotId: (input.storyAt ? input.storyAt.leafSlotId : snapshot.leaf)! }
              : {})
          })
        }
        const editRollout = yield* startEdit(input)
        const applied = yield* history.ApplyHistoryEdits({
          userId: input.userId,
          title: input.title,
          ...(input.prepared ? { prepared: input.prepared } : {}),
          applications: [
            { chatId: input.chatId, forkId: input.forkId, edits, summariesIncluded: input.summariesIncluded }
          ]
        })
        yield* sql`UPDATE changeset_groups SET origin='agent' WHERE id=${applied.groupId}`
        for (const id of applied.changesetIds)
          yield* sql`UPDATE changesets SET origin='agent',rollout_id=${editRollout} WHERE id=${id}`
        const result = JSON.stringify({
          chat: snapshot.name,
          chatId: input.chatId,
          changesetId: applied.changesetIds[0],
          messages: edits.filter((e) => e.kind === "version_replace").length,
          summaries: edits.filter((e) => e.kind === "summary_revision").length,
          instructions: edits.filter((e) => e.kind === "state_event").length
        })
        const seq = yield* nextSeq(sql, input.chatId)
        const [after] = yield* sql<{ state_seq: number }>`SELECT state_seq FROM chats WHERE id=${input.chatId}`
        // The run's receipt clock, as every other reply effect: bulk Undo follows call order.
        const receiptAt = yield* nextReceiptTime(sql, input.rolloutId)
        yield* sql`INSERT INTO rollout_receipts(rollout_id,tool_call_id,result_json,created_at) VALUES (${input.rolloutId},${input.toolCallId},${JSON.stringify(result)},${receiptAt})`
        const effectTitle = position
          ? `${input.title} · ${position.label} · messages ${range!.first}–${range!.last}`
          : input.title
        yield* sql`INSERT INTO rollout_effects(rollout_id,tool_call_id,seq,kind,target_kind,target_id,title,undo_json,created_at)
        VALUES (${input.rolloutId},${input.toolCallId},0,'changeset.apply','chat',${input.chatId},${effectTitle},${JSON.stringify({ changesetId: applied.changesetIds[0], chatId: input.chatId, forkId: input.forkId, bytes, ...(position ? { storyScope: { branch: position.naming, first: range!.first, last: range!.last }, scopeTitle: input.title } : {}), seq: after?.state_seq ?? seq })},${receiptAt})`
        return result
      }).pipe(transaction(sql, "ApplyAgentChangeset"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
}
