import { checkStoryWrite } from "./storyWriteScope.ts"
import { displayEndOf } from "./displayPath.ts"
import type { StoryAt } from "@rp/shared/chat.ts"
import { safeAgentDocument } from "./agentDocuments.ts"
import { historyCurrent, historyFork } from "./historyShared.ts"
import { nextReceiptTime, pendingOperationResult, unwrapOperationResult } from "./operationReceipts.ts"
import { isDeepStrictEqual } from "node:util"
import {
  operationPolicies,
  operationInfo,
  previousLibraryDocument,
  operationSnapshotMatches,
  refuseOperation,
  type OperationHandlers
} from "./operationPolicies.ts"
import { settingsRegistry, writeSetting } from "./settings.ts"
import { Schema } from "effect"
// Setup tools compose the same typed user operations in one outer writer transaction.
// The receipt and all undo recipes commit with them. No external work occurs here.
import { EffectUndoRefused, type RolloutEffect } from "@rp/shared/workshopApi.ts"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { newCardDoc, validateDoc, withoutGrantedAgentEdits, withHtmlApprovals } from "@rp/shared/editing.ts"
import { InvalidDocument } from "@rp/shared/editorApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Rpc } from "effect/rpc"
import type { OpsOf } from "./opsOf.ts"
import type { Doc, EntityKind, RefId, RevisionId } from "@rp/shared/library.ts"
import { encodeLibraryDoc } from "./libraryWrites.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeRegistry } from "@rp/shared/registry.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { toBinItem, type Bin } from "./bin.ts"
import { NotFound, WriteOps } from "./ops.ts"
import { adoptedKind } from "./cardOrigins.ts"
import { makeLibraryQueries } from "./library.ts"
import { transaction } from "./tx.ts"
import { workshopLimits as limits } from "../workshopLimits.ts"
import { capabilityDefaults, resolveMode, workshopCapabilities } from "../agent/capabilities.ts"

type Handlers = Parameters<typeof WriteOps.of>[0]
type OperationName =
  | "CreateEntity"
  | "EditRef"
  | "ForkCard"
  | "RestoreRevision"
  | "StartGreetingChat"
  | "AddStateEvents"
  | "RenameChats"
  | "RenameRef"
  | "SetRefArchived"
  | "SetCardFavourite"
  | "SetChatPin"
  | "ChangeGenerationDefaults"
  | "AddStateEvent"
  | "ForkWithDrafts"
  | "ApplyHistoryEdits"
  | "UndoHistoryEdit"
  | "SendOrQueue"
  | "DeleteMessage"
  | "RestoreBinItem"
  | "SetPersona"
  | "AdoptRemoteCard"
type OperationRpc<K> = Extract<OpsOf<typeof WriteOps>, { readonly _tag: K }>
type Operations = {
  [K in OperationName]: (
    input: Parameters<Handlers[K]>[0]
  ) => Effect.Effect<Rpc.Success<OperationRpc<K>>, Rpc.Error<OperationRpc<K>> | import("effect/sql").SqlError.SqlError>
}
type Key = {
  readonly userId: UserId
  readonly rolloutId: string
  readonly toolCallId: string
  readonly approvalDigest?: string
  readonly expectedRefs?: ReadonlyArray<{
    readonly refId: RefId
    readonly rowVersion: number
    readonly archivedAt?: number | null
  }>
}
interface EffectRow {
  rollout_id: string
  tool_call_id: string
  seq: number
  kind: string
  target_kind: string
  target_id: string
  title: string
  undo_json: string | null
  undo_result_json: string | null
  undone_at: number | null
  created_at: number
}
export const toRolloutEffect = (row: EffectRow): RolloutEffect => ({
  rolloutId: row.rollout_id,
  toolCallId: row.tool_call_id,
  seq: row.seq,
  kind: row.kind,
  targetKind: row.target_kind,
  targetId: row.target_id,
  title: row.title,
  undo: row.undo_json === null ? null : JSON.parse(row.undo_json),
  undoResult: row.undo_result_json === null ? null : JSON.parse(row.undo_result_json),
  undoneAt: row.undone_at,
  createdAt: row.created_at
})

// Undo policies are replaceable worker registrations; the transaction/ownership boundary is kernel.
interface Undoer {
  readonly id: string
  /** Optional read-only state proof for carrying a saved tool success into a new turn. */
  readonly unchanged?: (
    sql: SqlClient.SqlClient,
    userId: UserId,
    effect: RolloutEffect,
    effects: ReadonlyArray<RolloutEffect>
  ) => Effect.Effect<boolean, import("effect/sql").SqlError.SqlError>
  readonly run: (
    context: UndoContext,
    effect: RolloutEffect
  ) => Effect.Effect<
    Record<string, unknown>,
    | NotFound
    | EffectUndoRefused
    | import("@rp/shared/errors.ts").StaleWrite
    | import("@rp/shared/editorApi.ts").InvalidDocument
    | import("./ops.ts").RefOperationRefused
    | import("./ops.ts").StorageError
    | import("effect/sql").SqlError.SqlError
  >
}
interface UndoContext {
  readonly userId: UserId
  readonly sql: SqlClient.SqlClient
  readonly ops: Operations
  readonly bin: Bin
}
const refuse = (message = "Changed since; open its history before undoing this change.") =>
  new EffectUndoRefused({ message })
/** Operations whose whole effect is new library entries, with the capability each needs: Undo bins them. */
const creations: Readonly<Record<string, string>> = {
  CreateEntity: "library.write",
  ForkWithDrafts: "library.write",
  CreateCardNote: "library.write",
  CreateSharedNote: "library.write",
  CreateChatNote: "chats.setup",
  ImportFile: "library.write",
  // Add to my cards from a card source (cardextools1): its Undo bins the added card.
  AdoptRemoteCard: "library.write"
}

// A reverse-order undo restores content through new revisions. Only those known restores
// may advance a previous effect's expected head; a user's intervening edit still refuses.
const checkedRef = (ctx: UndoContext, effect: RolloutEffect) =>
  Effect.gen(function* () {
    const undo = effect.undo!
    const ref = yield* makeLibraryQueries(ctx.sql).ownedRef(ctx.userId, String(undo.refId))
    let head = String(undo.head)
    let version = Number(undo.rowVersion)
    const restored = yield* ctx.sql<{
      undo_json: string
      undo_result_json: string
    }>`SELECT undo_json, undo_result_json FROM rollout_effects
    WHERE target_kind = 'entity' AND target_id = ${effect.targetId} AND kind = 'library.revise' AND undone_at IS NOT NULL ORDER BY undone_at, created_at DESC`
    // A chain may have been undone at the same millisecond. Follow edges rather than clock order.
    const remaining = restored.map(
      (r) => ({ ...JSON.parse(r.undo_json), ...JSON.parse(r.undo_result_json) }) as Record<string, unknown>
    )
    for (;;) {
      const at = remaining.findIndex(
        (r) => r.before === head && Number(r.beforeRowVersion) === version && typeof r.restoredHead === "string"
      )
      if (at < 0) break
      const [edge] = remaining.splice(at, 1)
      head = String(edge!.restoredHead)
      version = Number(edge!.restoredRowVersion)
    }
    if (undo.exactDocument === true && ref.archived_at !== undo.archivedAt) return yield* refuse()
    if (ref.entity_id !== effect.targetId || ref.head_revision_id !== head || ref.row_version !== version)
      return yield* refuse()
    return ref
  })

const checkedCreation = (ctx: UndoContext, effect: RolloutEffect) =>
  Effect.gen(function* () {
    const ref = yield* checkedRef(ctx, effect)
    const undo = effect.undo!
    const [meta] = yield* ctx.sql<{ archived_at: number | null; tags: string; lineage: string }>`SELECT e.archived_at,
      (SELECT coalesce(json_group_array(tag), '[]') FROM (SELECT tag FROM entity_tags WHERE entity_id = e.id ORDER BY tag)) AS tags,
      json_array(e.forked_from_entity_id, e.forked_from_revision_id, e.forked_in_chat_id, e.forked_at) AS lineage
      FROM entities e WHERE e.id = ${effect.targetId}`
    if (!meta || meta.archived_at !== undo.archivedAt || meta.tags !== undo.tags || meta.lineage !== undo.lineage)
      return yield* refuse()
    const [draftStamp] = yield* ctx.sql<{
      stamp: string
    }>`SELECT coalesce(json_group_array(json_array(id, row_version)), '[]') AS stamp FROM (SELECT id, row_version FROM drafts WHERE target_kind = 'entity_field' AND target_id = ${ref.id} ORDER BY id)`
    if (draftStamp!.stamp !== undo.draftStamp)
      return yield* refuse("Unsaved text on the new item changed since; open its editor first.")
    return ref
  })

const libraryUnchanged: NonNullable<Undoer["unchanged"]> = Effect.fnUntraced(function* (sql, userId, effect, effects) {
  const undo = effect.undo!
  let head = undo.head
  let version = undo.rowVersion
  const remaining = effects
    .filter((e) => e.kind === "library.revise" && e.targetId === effect.targetId)
    .map((e) => e.undo!)
  for (;;) {
    const at = remaining.findIndex((r) => r.refId === undo.refId && r.before === head && r.beforeRowVersion === version)
    if (at < 0) break
    const edge = remaining.splice(at, 1)[0]!
    head = edge.head
    version = edge.rowVersion
  }
  const [ref] = yield* sql`SELECT 1 FROM entity_refs r JOIN entities e ON e.id = r.entity_id
    WHERE r.id = ${String(undo.refId)} AND e.id = ${effect.targetId} AND e.owner_user_id = ${userId}
      AND e.deleted_at IS NULL AND r.head_revision_id = ${String(head)} AND r.row_version = ${Number(version)}`
  return !!ref
})

const createUndoer: Undoer = {
  id: "library.create",
  unchanged: libraryUnchanged,
  run: (ctx, effect) =>
    Effect.gen(function* () {
      const ref = yield* checkedCreation(ctx, effect)
      const undo = effect.undo!
      if (ref.kind === "card") {
        const live = yield* ctx.sql<{ id: string }>`SELECT e.id FROM entities e
          JOIN entity_refs r ON r.entity_id = e.id JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE e.owner_user_id = ${ctx.userId} AND e.kind = 'note' AND e.deleted_at IS NULL
            AND json_extract(h.doc_json, '$.owner.card') = ${effect.targetId}`
        const siblings = yield* ctx.sql<EffectRow>`SELECT * FROM rollout_effects
          WHERE rollout_id = ${effect.rolloutId} AND tool_call_id = ${effect.toolCallId} AND kind = 'library.create'`
        const expected = (undo.notes ?? []) as ReadonlyArray<string>
        const active = expected.filter((id) => !siblings.some((row) => row.target_id === id && row.undone_at !== null))
        if (live.length !== active.length || live.some((note) => !active.includes(note.id)))
          return yield* refuse("Notes on this card changed since; open its editor before undoing it.")
        for (const id of active) {
          const sibling = siblings.find((row) => row.target_id === id)
          if (!sibling) return yield* refuse()
          yield* checkedCreation(ctx, toRolloutEffect(sibling))
        }
      }
      // Drafts moved by ForkCard are restored with their history intact. Refuse if either end
      // was typed on since the tool moved it. The copied drafts stay with the binned copy.
      const carries = (undo.carries ?? []) as Array<{
        id: string
        content: string
        base: string | null
        afterVersion: number
      }>
      for (const carry of carries) {
        const [row] = yield* ctx.sql<{
          target_id: string
          field: string
        }>`SELECT target_id, field FROM drafts WHERE id = ${carry.id} AND user_id = ${ctx.userId} AND row_version = ${carry.afterVersion}`
        if (!row) return yield* refuse("Unsaved source text changed since; restore it from its history.")
        const draft = yield* ctx.bin.drafts.find(
          ctx.userId,
          new DraftKey({ targetKind: "entity_field", targetId: row.target_id, field: row.field })
        )
        if (!draft) return yield* refuse()
        yield* ctx.bin.drafts
          .save({
            userId: ctx.userId,
            key: new DraftKey({ targetKind: "entity_field", targetId: draft.target_id, field: draft.field }),
            draftId: draft.id,
            content: carry.content,
            base: { rowVersion: draft.row_version, session: draft.session },
            baseRevision: carry.base,
            checkTarget: Effect.void
          })
          .pipe(Effect.catchTag("DraftTooLarge", () => Effect.fail(refuse())))
      }
      // Use the bin's ordinary delete, without capacity eviction: undo never purges history.
      yield* ctx.bin.deleteEntity(ctx.userId, ref.entity_id)
      return {}
    })
}
const reviseUndoer: Undoer = {
  id: "library.revise",
  unchanged: libraryUnchanged,
  run: (ctx, effect) =>
    Effect.gen(function* () {
      const ref = yield* checkedRef(ctx, effect)
      // Explicit user Undo restores the recorded document exactly, including its prior
      // approvals, and leaves active drafts alone. This is never tool-reachable approval.
      const change =
        effect.undo!.exactDocument === true
          ? yield* ctx.ops.EditRef({
              userId: ctx.userId,
              refId: ref.id as RefId,
              expectedRowVersion: ref.row_version,
              doc: yield* previousLibraryDocument(ctx.sql, ctx.userId, ref.id, String(effect.undo!.before)),
              message: "Undid a workshop edit",
              commitDraft: null
            })
          : yield* ctx.ops.RestoreRevision({
              userId: ctx.userId,
              refId: ref.id as RefId,
              revisionId: String(effect.undo!.before) as RevisionId,
              expectedRowVersion: ref.row_version
            })
      return { restoredHead: change.ref.headRevisionId, restoredRowVersion: change.ref.rowVersion }
    })
}
const chatStamp = (sql: SqlClient.SqlClient, userId: UserId, chatId: string) =>
  sql<{
    stamp: string
  }>`SELECT json_array(c.title, c.status, c.title_source, c.cover_media_id, c.row_version, c.state_seq, c.active_leaf_slot_id, c.current_fork_id,
    (SELECT coalesce(json_group_array(json_array(id, updated_at, content, reasoning, status, deleted_at, hidden, starred, mark)), '[]')
      FROM (SELECT * FROM version_records WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = c.id) ORDER BY id)),
    (SELECT coalesce(json_group_array(json_array(id, row_version, selected_version_id, context_excluded, deleted_at)), '[]')
      FROM (SELECT * FROM slots WHERE chat_id = c.id ORDER BY id)),
    (SELECT coalesce(json_group_array(json_array(id, row_version, tip_slot_id, deleted_at)), '[]')
      FROM (SELECT * FROM forks WHERE chat_id = c.id ORDER BY id)),
    (SELECT count(*) FROM state_events WHERE chat_id = c.id),
    (SELECT count(*) FROM fork_overrides WHERE chat_id = c.id),
    (SELECT coalesce(json_group_array(json_array(id, row_version)), '[]') FROM (SELECT id, row_version FROM drafts WHERE target_id = c.id ORDER BY id)),
    (SELECT count(*) FROM chat_pins WHERE chat_id = c.id)) AS stamp
    FROM chats c WHERE c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`

const chatUndoer: Undoer = {
  id: "chat.create",
  unchanged: Effect.fnUntraced(function* (sql, userId, effect) {
    const [chat] = yield* chatStamp(sql, userId, effect.targetId)
    return !!chat && chat.stamp === effect.undo!.stamp
  }),
  run: (ctx, effect) =>
    Effect.gen(function* () {
      const [chat] = yield* chatStamp(ctx.sql, ctx.userId, effect.targetId)
      if (!chat || chat.stamp !== effect.undo!.stamp) return yield* refuse()
      yield* ctx.bin.deleteChat(ctx.userId, effect.targetId)
      return {}
    })
}
const operationUndo: Undoer = {
  id: "chat.change",
  unchanged: (sql, userId, effect) =>
    Effect.gen(function* () {
      const recipe = effect.undo!
      if (typeof recipe.changesetId === "string") {
        const fork = yield* historyFork(sql, userId, String(recipe.chatId), String(recipe.forkId))
        const items = yield* sql<{
          target_kind: "version_replace" | "summary_revision" | "state_event"
          target_id: string
          after_json: string
        }>`SELECT target_kind,target_id,after_json FROM changeset_items WHERE changeset_id=${recipe.changesetId}`
        if (!items.length) return false
        for (const item of items) {
          const current = yield* historyCurrent(sql, fork, { kind: item.target_kind, targetId: item.target_id })
          const after = JSON.parse(item.after_json)
          if (current?.id !== after.id || current?.content !== after.content) return false
        }
        return true
      }
      const policy = operationPolicies.get(String(recipe.operation))
      if (!policy) return false
      const current = yield* policy.before(sql, userId, recipe.input as never)
      return operationSnapshotMatches(policy, current, recipe.next)
    }).pipe(Effect.orElseSucceed(() => false)),
  run: (ctx, effect) =>
    Effect.gen(function* () {
      const recipe = effect.undo!
      if (typeof recipe.changesetId === "string") {
        const result = yield* ctx.ops.UndoHistoryEdit({
          userId: ctx.userId,
          chatId: recipe.chatId as never,
          forkId: recipe.forkId as never,
          changesetId: recipe.changesetId
        })
        if (result.conflicts.length) return yield* refuse("Some history changed since. Open History edits to undo it.")
        return { undone: result.undone }
      }
      const policy = operationPolicies.get(String(recipe.operation))
      if (!policy) return yield* refuse("This operation no longer has an undo policy.")
      // A newer operation may have been undone through a fresh state write/revision.
      // Follow only exact recorded restore edges; an intervening user write still
      // fails the final policy proof, even if its visible value happens to be equal.
      const restored = yield* ctx.sql<{
        undo_json: string
        undo_result_json: string
      }>`SELECT undo_json, undo_result_json
        FROM rollout_effects WHERE target_kind = ${effect.targetKind} AND target_id = ${effect.targetId}
          AND undone_at IS NOT NULL AND undo_json IS NOT NULL AND undo_result_json IS NOT NULL`
      const edges = restored
        .map((row) => ({ recipe: JSON.parse(row.undo_json), result: JSON.parse(row.undo_result_json) }))
        .filter((edge) => edge.recipe.operation === recipe.operation && Object.hasOwn(edge.result, "restoredSnapshot"))
      let expected = recipe.next
      for (;;) {
        const at = edges.findIndex((edge) => isDeepStrictEqual(edge.recipe.prior, expected))
        if (at < 0) break
        expected = edges.splice(at, 1)[0]!.result.restoredSnapshot
      }
      const current = yield* policy.before(ctx.sql, ctx.userId, recipe.input as never)
      if (!operationSnapshotMatches(policy, current, expected)) return yield* refuse()
      const result = yield* policy.undo(
        ctx.sql,
        ctx.ops as OperationHandlers,
        ctx.userId,
        recipe.input as never,
        recipe.prior as never,
        expected as never
      )
      return {
        ...(result as Record<string, unknown>),
        restoredSnapshot: yield* policy.before(ctx.sql, ctx.userId, recipe.input as never)
      }
    }).pipe(
      Effect.mapError((error) =>
        refuse(error instanceof Error ? error.message : "This change cannot be undone safely.")
      )
    )
}
export const rolloutUndoers = makeRegistry<Undoer>([
  createUndoer,
  {
    ...reviseUndoer,
    unchanged: (sql, userId, effect, effects) =>
      effect.undo?.operation
        ? operationUndo.unchanged!(sql, userId, effect, effects)
        : libraryUnchanged(sql, userId, effect, effects),
    run: (ctx, effect) => (effect.undo?.operation ? operationUndo.run(ctx, effect) : reviseUndoer.run(ctx, effect))
  },
  chatUndoer,
  operationUndo,
  { ...operationUndo, id: "setting.set" },
  { ...operationUndo, id: "library.delete" },
  { ...operationUndo, id: "reply.generate" },
  { ...operationUndo, id: "changeset.apply" }
])

/** A carried transcript includes all ancestors' successful changes. Revalidate their final
 * saved state in the reader worker; never replay a success after its undo or a user edit. */
export const continuityEffectsReason = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  rolloutId: string
) {
  const rows = yield* sql<EffectRow>`WITH RECURSIVE runs(id, parent_rollout_id) AS (
    SELECT id, parent_rollout_id FROM rollouts WHERE id = ${rolloutId}
    UNION
    SELECT r.id, r.parent_rollout_id FROM rollouts r JOIN runs p ON r.id = p.parent_rollout_id
  ) SELECT e.* FROM runs JOIN rollout_effects e ON e.rollout_id = runs.id`
  if (rows.some((e) => e.undone_at !== null))
    return "A previous change was undone, so this request was put together again from the messages."
  const changed =
    "The library or a chat changed after the previous run, so this request was put together again from the messages."
  const effects = rows.map(toRolloutEffect)
  for (const effect of effects) {
    const unchanged = rolloutUndoers.get(effect.kind)?.unchanged
    if (!effect.undo || !unchanged || !(yield* unchanged(sql, userId, effect, effects))) return changed
  }
  return null
})

export const makeWorkshopEffectHandlers = (ops: Operations, bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lib = makeLibraryQueries(sql)
    const owned = (key: Key) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          status: string
          chat_kind: string
          kind: string
        }>`SELECT r.status, c.kind AS chat_kind, r.kind FROM rollouts r JOIN chats c ON c.id = r.chat_id
      WHERE r.id = ${key.rolloutId} AND c.owner_user_id = ${key.userId} AND r.kind = 'workshop' AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "workshop rollout", id: key.rolloutId })
        const profile = chatKinds.get(row.chat_kind)
        if (!profile?.allowsOutside || profile.rolloutKind !== row.kind)
          return yield* new NotFound({ entity: "workshop rollout", id: key.rolloutId })
        return row
      })
    /** One effect's undo, inside the caller's transaction; one already undone stays as it is. */
    const undoRow = (userId: UserId, row: EffectRow) =>
      Effect.gen(function* () {
        if (row.kind.startsWith("plugin.")) return yield* refuse("Plugin file undo must run through the host.")
        if (row.undone_at !== null) return toRolloutEffect(row)
        const undoer = rolloutUndoers.get(row.kind)
        if (!undoer || row.undo_json === null)
          return yield* new EffectUndoRefused({ message: "This change cannot be undone here." })
        const undoResult = yield* undoer
          .run({ sql, userId, ops, bin }, toRolloutEffect(row))
          .pipe(Effect.catchTag(["StaleWrite", "InvalidDocument", "RefOperationRefused"], () => Effect.fail(refuse())))
        const at = Math.max(Date.now(), row.created_at)
        yield* sql`UPDATE rollout_effects SET undone_at = ${at}, undo_result_json = ${JSON.stringify(undoResult)} WHERE rollout_id = ${row.rollout_id} AND tool_call_id = ${row.tool_call_id} AND seq = ${row.seq}`
        return toRolloutEffect({ ...row, undone_at: at, undo_result_json: JSON.stringify(undoResult) })
      })
    const receipted = <R, E>(
      key: Key,
      capability: string,
      body: Effect.Effect<
        {
          result: R
          effects: ReadonlyArray<
            Omit<RolloutEffect, "rolloutId" | "toolCallId" | "seq" | "undoResult" | "undoneAt" | "createdAt">
          >
        },
        E
      >
    ) =>
      Effect.gen(function* () {
        const rollout = yield* owned(key)
        const [receipt] = yield* sql<{
          result_json: string
        }>`SELECT result_json FROM rollout_receipts WHERE rollout_id = ${key.rolloutId} AND tool_call_id = ${key.toolCallId}`
        if (receipt) return JSON.parse(receipt.result_json) as R
        if (!["running", "created"].includes(rollout.status))
          return yield* new EffectUndoRefused({ message: "This workshop run is no longer running." })
        // Check the current permission in the same transaction as the change. An Off choice
        // or a new Ask-first choice in another tab cannot race the main-thread permit.
        const grants = yield* sql<{ capability: string; mode: "off" | "ask" | "allow" }>`SELECT capability, mode
          FROM workshop_grants WHERE chat_id = (SELECT chat_id FROM rollouts WHERE id = ${key.rolloutId})
            AND owner_user_id = ${key.userId} AND target = '' AND (expires_at IS NULL OR expires_at > ${Date.now()})`
        const mode = resolveMode(
          { workshopCapabilities, capabilityDefaults },
          new Map(grants.map((g) => [g.capability, g.mode])),
          capability,
          "library"
        )
        if (mode === "off")
          return yield* new EffectUndoRefused({ message: "This capability is turned off in this workshop." })
        if (mode === "ask") {
          const [approval] = yield* sql`SELECT 1 FROM tool_approvals WHERE rollout_id = ${key.rolloutId}
            AND tool_call_id = ${key.toolCallId} AND capability = ${capability}
            AND digest = ${key.approvalDigest ?? null} AND status = 'used'`
          if (!approval)
            return yield* new EffectUndoRefused({ message: "This change needs a current approval. Ask again." })
        }
        for (const expected of key.expectedRefs ?? []) {
          const ref = yield* lib.ownedRef(key.userId, expected.refId)
          if (
            ref.row_version !== expected.rowVersion ||
            ("archivedAt" in expected && ref.archived_at !== expected.archivedAt)
          )
            return yield* new EffectUndoRefused({
              message: "The saved item changed while waiting. Read it again before making this change."
            })
        }
        const [used] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM rollout_receipts
          WHERE rollout_id = ${key.rolloutId} AND is_error = 0`
        if (used!.n >= limits.calls)
          return yield* new EffectUndoRefused({
            message: `This run has reached its limit of ${limits.calls} changes. Start another turn to continue.`
          })
        const { result, effects } = yield* body
        const [recorded] = yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM rollout_effects WHERE rollout_id = ${key.rolloutId}`
        if (recorded!.n + effects.length > limits.effects)
          return yield* new EffectUndoRefused({
            message: `This run can change at most ${limits.effects} items. Start another turn to continue.`
          })
        const at = yield* nextReceiptTime(sql, key.rolloutId)
        yield* sql`INSERT INTO rollout_receipts ${sql.insert({ rollout_id: key.rolloutId, tool_call_id: key.toolCallId, result_json: JSON.stringify(result), created_at: at })}`
        for (const [seq, effect] of effects.entries())
          yield* sql`INSERT INTO rollout_effects ${sql.insert({ rollout_id: key.rolloutId, tool_call_id: key.toolCallId, seq, kind: effect.kind, target_kind: effect.targetKind, target_id: effect.targetId, title: effect.title, undo_json: effect.undo === null ? null : JSON.stringify(effect.undo), created_at: at })}`
        return result
      }).pipe(transaction(sql, "WorkshopEffect"))
    const checkDocument = (doc: unknown) =>
      Buffer.byteLength(JSON.stringify(doc), "utf8") <= limits.documentBytes
        ? Effect.void
        : Effect.fail(
            new InvalidDocument({ problems: [`Workshop documents are limited to ${limits.documentBytes} bytes.`] })
          )
    const creation = (refId: RefId) =>
      Effect.gen(function* () {
        const ref = (yield* lib.refsWhere("r.id = ?", [refId]))[0]!
        const [meta] = yield* sql<{
          archived_at: number | null
          tags: string
          lineage: string
          draftStamp: string
        }>`SELECT e.archived_at,
      (SELECT coalesce(json_group_array(tag), '[]') FROM (SELECT tag FROM entity_tags WHERE entity_id = e.id ORDER BY tag)) AS tags,
      json_array(e.forked_from_entity_id, e.forked_from_revision_id, e.forked_in_chat_id, e.forked_at) AS lineage,
      (SELECT coalesce(json_group_array(json_array(id, row_version)), '[]') FROM (SELECT id, row_version FROM drafts WHERE target_kind = 'entity_field' AND target_id = ${refId} ORDER BY id)) AS draftStamp
      FROM entities e WHERE e.id = ${ref.entity_id}`
        const notes =
          ref.kind !== "card"
            ? []
            : yield* sql<{ id: string }>`SELECT e.id FROM entities e
          JOIN entity_refs r ON r.entity_id = e.id JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE e.owner_user_id = (SELECT owner_user_id FROM entities WHERE id = ${ref.entity_id})
            AND e.kind = 'note' AND e.deleted_at IS NULL AND json_extract(h.doc_json, '$.owner.card') = ${ref.entity_id}`
        return {
          kind: "library.create",
          targetKind: "entity",
          targetId: ref.entity_id,
          title: `Created the ${ref.kind} ${ref.label}`,
          undo: {
            refId,
            head: ref.head_revision_id,
            rowVersion: ref.row_version,
            archivedAt: meta!.archived_at,
            tags: meta!.tags,
            lineage: meta!.lineage,
            draftStamp: meta!.draftStamp,
            notes: notes.map((note) => note.id)
          }
        }
      })
    return {
      RunWorkshopOperation: (input) =>
        Effect.gen(function* () {
          const policy = operationPolicies.get(input.operation)
          const creates = Object.hasOwn(creations, input.operation)
          if ((!policy && !creates) || input.capability !== (policy?.capability ?? creations[input.operation]))
            return yield* refuseOperation("This operation has no safe undo recipe, so it wasn't done.")
          const value = input.payload as Record<string, unknown>
          const rpc = WriteOps.requests.get(input.operation as never)
          if ((!rpc && input.operation !== "SetAgentSetting") || !value || value.userId !== input.userId)
            return yield* refuseOperation("Invalid operation owner.")
          const payload = yield* Schema.decodeUnknownEffect(
            rpc?.payloadSchema ??
              Schema.Struct({
                userId: Schema.String,
                key: Schema.String,
                value: Schema.Unknown,
                expectedRevision: Schema.Int
              })
          )(value).pipe(Effect.mapError(() => refuseOperation("Invalid operation arguments.")))
          const handler = (ops as unknown as Record<string, (input: unknown) => Effect.Effect<unknown, unknown>>)[
            input.operation
          ]
          return unwrapOperationResult(
            yield* receipted(
              input,
              input.capability,
              Effect.gen(function* () {
                const expected = input.expected as { payload?: Record<string, unknown>; proof?: unknown }
                const storyAt = (expected?.proof as { storyAt?: StoryAt } | undefined)?.storyAt
                let storyPosition: Effect.Success<ReturnType<typeof checkStoryWrite>> = undefined
                const chatTargets =
                  typeof value.chatId === "string"
                    ? [value.chatId]
                    : Array.isArray(value.chats)
                      ? value.chats.map((c: { chatId: string }) => c.chatId)
                      : Array.isArray(value.applications)
                        ? value.applications.map((c: { chatId: string }) => c.chatId)
                        : []
                for (const chatId of chatTargets) {
                  storyPosition = yield* checkStoryWrite(sql, input.userId, input.rolloutId, chatId, storyAt)
                  if (storyPosition) {
                    if (input.operation === "AddStateEvent" || input.operation === "AddStateEvents") {
                      value.displayEnd = false
                      ;(payload as Record<string, unknown>).displayEnd = false
                    }
                    if ("forkId" in value && value.forkId !== storyAt!.forkId)
                      return yield* refuseOperation("This change names another story branch.")
                    for (const field of ["slotId", "parentSlotId", "leaf"])
                      if (field in value && value[field] !== storyAt!.leafSlotId)
                        return yield* refuseOperation("This change must use the story tab’s position.")
                    if (
                      input.operation === "SendOrQueue" &&
                      (yield* displayEndOf(sql, chatId, storyPosition.fork)) !== storyAt!.leafSlotId
                    )
                      return yield* refuseOperation("Open the end of this branch before asking for a reply there.")
                  }
                }
                if (expected?.proof) {
                  const proof = expected.proof as {
                    storyAt?: StoryAt
                    chat?: { id: import("@rp/shared/chat.ts").ChatId }
                    chats?: ReadonlyArray<{ id: import("@rp/shared/chat.ts").ChatId }>
                    historyTargets?: ReadonlyArray<{ chatId: string; forkId: string }>
                    refs?: Array<{ refId: string; rowVersion: number; archivedAt?: number | null }>
                  }
                  for (const expectedRef of proof.refs ?? []) {
                    const current = yield* lib.ownedRef(input.userId, expectedRef.refId)
                    if (
                      current.row_version !== expectedRef.rowVersion ||
                      ("archivedAt" in expectedRef && current.archived_at !== expectedRef.archivedAt)
                    )
                      return yield* refuseOperation("The saved library item changed while waiting. Read it again.")
                  }
                  for (const chat of proof.chats ?? []) {
                    const current = yield* operationInfo(sql, { userId: input.userId, chatId: chat.id })
                    if (JSON.stringify(current.proof) !== JSON.stringify(chat))
                      return yield* refuseOperation(
                        "The saved chat changed while waiting. Read it again and ask again."
                      )
                  }
                  if (input.operation === "ApplyHistoryEdits" && proof.historyTargets) {
                    const applications = value.applications as ReadonlyArray<{ chatId: string; forkId: string }>
                    if (
                      applications.some(
                        (application) =>
                          !proof.historyTargets!.some(
                            (target) => target.chatId === application.chatId && target.forkId === application.forkId
                          )
                      )
                    )
                      return yield* refuseOperation(
                        "The saved history targets changed while waiting. Read them again and ask again."
                      )
                  }
                  const current = proof.chat
                    ? yield* operationInfo(sql, {
                        userId: input.userId,
                        chatId: proof.chat.id,
                        ...(proof.storyAt ? { storyAt: proof.storyAt } : {})
                      })
                    : null
                  if (proof.chat && JSON.stringify(current!.proof) !== JSON.stringify(proof.chat))
                    return yield* refuseOperation("The saved chat changed while waiting. Read it again and ask again.")
                }
                if (creates && input.operation === "AdoptRemoteCard") {
                  // The user's Add to my cards, with the same rule as a file the assistant imports:
                  // nothing in it grants a permission, and scripts and HTML stay off.
                  const file = value.file as Record<string, unknown>
                  const kind = adoptedKind(String(file.docJson))
                  const safe = yield* Effect.try({
                    try: () => {
                      const doc = JSON.parse(String(file.docJson)) as Doc
                      const ours = (doc.extensions as { rp_harness?: { skills?: unknown } } | undefined)?.rp_harness
                      if (ours?.skills !== undefined) return null
                      return encodeLibraryDoc(
                        safeAgentDocument(
                          kind,
                          {},
                          withHtmlApprovals(
                            {},
                            {
                              ...withoutGrantedAgentEdits(kind, {}, doc),
                              ...(kind === "lorebook" ? {} : { regex_approved: false })
                            }
                          )
                        )
                      )
                    },
                    catch: () => refuseOperation("This card can't be added here. Add it from its page.")
                  })
                  if (safe === null)
                    return yield* refuseOperation("This card carries its own skills. Add it from its page.")
                  yield* checkDocument(JSON.parse(safe.json))
                  const result = (yield* handler!({
                    ...(payload as object),
                    file: { ...file, docJson: safe.json, docHash: safe.hash, searchText: safe.searchText }
                  })) as { entityId: string; refId: RefId; existing: boolean }
                  // A card the user has from there already: nothing was added, so nothing to undo.
                  if (result.existing) return { result: pendingOperationResult(input.operation, result), effects: [] }
                  const first = yield* creation(result.refId)
                  const effects = [first]
                  for (const note of first.undo.notes) {
                    const [ref] = yield* sql<{ id: RefId }>`SELECT id FROM entity_refs WHERE entity_id = ${note}
                      ORDER BY id LIMIT 1`
                    effects.push(yield* creation(ref!.id))
                  }
                  return { result: pendingOperationResult(input.operation, result), effects }
                }
                if (creates) {
                  if (input.operation === "ForkWithDrafts" && value.moveDrafts !== false)
                    return yield* refuseOperation(
                      "Moving unsaved drafts cannot be undone by this tool. Set moveDrafts to false."
                    )
                  // These also write a note slot or a branch's revision, which binning the
                  // new note would not put back.
                  if (
                    (input.operation === "CreateSharedNote" && value.fromNoteRefId !== undefined) ||
                    (["CreateSharedNote", "CreateCardNote"].includes(input.operation) && value.chatNote !== undefined)
                  )
                    return yield* refuseOperation("Make this note from the note's own editor.")
                  // A file may only add a new entry here: a new version of an existing one
                  // merges into it and its followers, which binning a creation cannot undo.
                  if (
                    input.operation === "ImportFile" &&
                    (value.intoRefId !== null ||
                      value.replace !== undefined ||
                      value.stageMerge !== undefined ||
                      value.arrival !== undefined ||
                      value.recognized !== undefined ||
                      value.presetLorebooks !== undefined ||
                      (value.media as ReadonlyArray<unknown>).length > 0)
                  )
                    return yield* refuseOperation("Import this file from the library page.")
                  // A file the assistant imports is its own writing: as with its edits, changed
                  // scripts and HTML stay off and nothing in it grants a permission.
                  let imported: Record<string, unknown> = {}
                  if (input.operation === "ImportFile") {
                    const kind = value.kind as EntityKind
                    const note = (json: unknown) =>
                      typeof json === "string"
                        ? JSON.stringify(withoutGrantedAgentEdits("note", {}, JSON.parse(json) as Doc))
                        : null
                    const safe = yield* Effect.try({
                      try: () => {
                        const file = JSON.parse(String(value.docJson)) as Doc
                        const ours = (file.extensions as { rp_harness?: { skills?: unknown } } | undefined)?.rp_harness
                        if (kind === "note" || ours?.skills !== undefined) return null
                        const whole = kind === "preset" ? (JSON.parse(encodeLibraryDoc(file).json) as Doc) : file
                        return encodeLibraryDoc(
                          safeAgentDocument(
                            kind,
                            {},
                            withHtmlApprovals(
                              {},
                              {
                                ...withoutGrantedAgentEdits(kind, {}, whole),
                                ...(kind === "lorebook" ? {} : { regex_approved: false })
                              }
                            )
                          )
                        )
                      },
                      catch: () => refuseOperation("This file can't be imported here. Import it from the library page.")
                    })
                    if (safe === null)
                      return yield* refuseOperation(
                        "This file is a note or a card with its own skills. Import it from the library page."
                      )
                    imported = {
                      docJson: safe.json,
                      docHash: safe.hash,
                      searchText: safe.searchText,
                      noteDocJson: note(value.noteDocJson),
                      ...(value.notesDocJson === undefined
                        ? {}
                        : { notesDocJson: (value.notesDocJson as ReadonlyArray<unknown>).map(note) })
                    }
                    for (const json of [
                      imported.docJson,
                      imported.noteDocJson,
                      ...((imported.notesDocJson ?? []) as unknown[])
                    ])
                      if (typeof json === "string") yield* checkDocument(JSON.parse(json))
                  }
                  const origin = `${input.rolloutId}:${input.toolCallId}`
                  const result = yield* handler!({
                    ...(payload as object),
                    ...imported,
                    ...(input.operation === "CreateEntity" ? { origin: "agent", originRef: origin } : {}),
                    ...(["CreateCardNote", "CreateChatNote", "CreateSharedNote"].includes(input.operation)
                      ? { agentOriginRef: origin }
                      : {})
                  })
                  const made = (
                    input.operation === "CreateEntity" || input.operation === "ImportFile"
                      ? (result as { ref: unknown }).ref
                      : result
                  ) as { id: RefId }
                  if (input.operation === "ImportFile" && (result as { created: boolean }).created !== true)
                    return yield* refuseOperation("Import this file from the library page.")
                  const first = yield* creation(made.id)
                  const effects = [first]
                  // A card's Undo answers for the notes that came with it (`createUndoer`).
                  for (const note of input.operation === "ImportFile" ? first.undo.notes : []) {
                    const [ref] = yield* sql<{ id: RefId }>`SELECT id FROM entity_refs WHERE entity_id = ${note}
                      ORDER BY id LIMIT 1`
                    effects.push(yield* creation(ref!.id))
                  }
                  return { result: pendingOperationResult(input.operation, result), effects }
                }
                if (input.operation === "SendOrQueue") {
                  const running = yield* sql`SELECT 1 FROM versions v JOIN slots s ON s.id = v.slot_id
              WHERE s.chat_id = ${String(value.chatId)} AND v.status = 'generating' AND v.deleted_at IS NULL`
                  if (running.length)
                    return yield* refuseOperation("That chat is writing a reply. Wait until it finishes.")
                }
                if (input.operation === "RestoreRevision") {
                  const ref = yield* lib.ownedRef(input.userId, String(value.refId))
                  const old = yield* lib.loadDoc(ref.head_revision_id)
                  const [revision] =
                    yield* sql`SELECT 1 FROM entity_revisions WHERE id = ${String(value.revisionId)} AND entity_id = ${ref.entity_id}`
                  if (!revision) return yield* new NotFound({ entity: "revision", id: String(value.revisionId) })
                  const next = yield* lib.loadDoc(String(value.revisionId))
                  // Content restores are sanitized below. Permission-only restores retain
                  // W6's explicit refusal rather than claiming to change a user's grant.
                  const presetPermissionChange =
                    ref.kind === "preset" &&
                    ((isDeepStrictEqual(old.regex, next.regex) &&
                      (next.regex_approved === true) !== (old.regex_approved === true)) ||
                      ([
                        "regex",
                        "prompts",
                        "order",
                        "utility_prompts",
                        "prefill",
                        "reply_sections",
                        "lorebooks",
                        "extensions",
                        "unsupported"
                      ].every((key) => isDeepStrictEqual(old[key], next[key])) &&
                        ["html_scripts_approved", "html_network_approved"].some(
                          (key) => (old[key] === true) !== (next[key] === true)
                        )))
                  if (
                    presetPermissionChange ||
                    (ref.kind !== "preset" &&
                      ref.kind !== "lorebook" &&
                      (!isDeepStrictEqual(withoutGrantedAgentEdits(ref.kind, old, next), next) ||
                        !isDeepStrictEqual(withoutGrantedAgentEdits(ref.kind, next, old), old) ||
                        !isDeepStrictEqual(withHtmlApprovals(old, next), next) ||
                        (next.regex_approved === true) !== (old.regex_approved === true)))
                  )
                    return yield* refuseOperation(
                      "Restoring this revision would change permissions. Restore it yourself from History."
                    )
                }
                const before = yield* policy!.before(sql, input.userId, value as never)
                let result: unknown
                if (input.operation === "SetAgentSetting") {
                  const entry = settingsRegistry.get(String(value.key))
                  if (!entry?.agent || entry.scope !== "user" || !entry.accepts(value.value))
                    return yield* refuseOperation("This setting is not agent-changeable, or its value is invalid.")
                  result = yield* writeSetting(
                    sql,
                    "user",
                    input.userId,
                    entry.id,
                    value.value,
                    Number(value.expectedRevision)
                  )
                } else if (input.operation === "RestoreRevision") {
                  const ref = yield* lib.ownedRef(input.userId, String(value.refId))
                  // Assistant restores are saved edits; unlike the user's History action,
                  // they must never settle or replace active drafts.
                  if (ref.kind === "preset" || ref.kind === "lorebook")
                    result = yield* ops.EditRef({
                      userId: input.userId,
                      refId: ref.id as RefId,
                      expectedRowVersion: Number(value.expectedRowVersion),
                      doc: safeAgentDocument(
                        ref.kind,
                        yield* lib.loadDoc(ref.head_revision_id),
                        yield* lib.loadDoc(String(value.revisionId))
                      ),
                      message: "Restored in the workshop",
                      commitDraft: null,
                      agentOriginRef: `${input.rolloutId}:${input.toolCallId}`
                    })
                  else result = yield* handler!(payload)
                } else if (input.operation === "DeleteEntity") {
                  // The bin's own delete, as Undo of a creation uses it: a tool's delete
                  // never pushes older items out of a full bin.
                  const itemId = yield* bin.deleteEntity(input.userId, String(value.entityId))
                  result = toBinItem(yield* bin.loadItem(input.userId, itemId))
                } else result = yield* handler!(payload)
                const after = yield* policy!.before(sql, input.userId, value as never)
                const priorRef = before as { ref?: { id: string; head_revision_id: string; row_version: number } }
                const nextRef = after as { ref?: { id: string; head_revision_id: string; row_version: number } }
                return {
                  result: pendingOperationResult(input.operation, result ?? null),
                  effects: [
                    {
                      kind: policy!.kind,
                      targetKind: policy!.targetKind,
                      targetId: policy!.target(value as never, after as never),
                      title: storyPosition
                        ? `${policy!.label} · ${storyPosition.label} · from message ${storyPosition.upTo}`
                        : policy!.kind === "library.delete"
                          ? `Moved the note ${(after as { label: string }).label} to the bin`
                          : policy!.label,
                      undo: {
                        operation: input.operation,
                        ...(storyPosition
                          ? {
                              storyAt,
                              storyScope: {
                                branch: storyPosition.naming,
                                first: storyPosition.upTo,
                                last: storyPosition.upTo,
                                from: true
                              },
                              scopeTitle: policy!.label
                            }
                          : {}),
                        input: value,
                        prior: before,
                        next: after,
                        ...(policy!.kind === "library.revise"
                          ? {
                              refId: nextRef.ref!.id,
                              head: nextRef.ref!.head_revision_id,
                              rowVersion: nextRef.ref!.row_version,
                              before: priorRef.ref!.head_revision_id,
                              beforeRowVersion: priorRef.ref!.row_version
                            }
                          : {}),
                        // Open leads to the note once Undo has taken it back out of the bin.
                        ...(policy!.kind === "library.delete" ? { refId: (after as { refId: string }).refId } : {})
                      }
                    }
                  ]
                }
              })
            )
          ) as unknown
        }).pipe(
          Effect.mapError((error) =>
            error instanceof EffectUndoRefused || error instanceof NotFound || error instanceof InvalidDocument
              ? error
              : refuse(error instanceof Error ? error.message : "This operation could not be saved.")
          )
        ),
      AgentCreateEntity: (input) =>
        receipted(
          input,
          "library.write",
          Effect.gen(function* () {
            yield* checkDocument(input.doc)
            const valid = validateDoc(
              input.kind,
              withHtmlApprovals(
                {},
                {
                  ...withoutGrantedAgentEdits(
                    input.kind,
                    input.kind === "card" ? newCardDoc(input.label) : {},
                    input.doc
                  ),
                  regex_approved: false
                }
              )
            )
            if (!valid.ok) return yield* new InvalidDocument({ problems: valid.problems })
            const doc = safeAgentDocument(input.kind, {}, valid.doc)
            yield* checkDocument(doc)
            const { ref } = yield* ops.CreateEntity({
              userId: input.userId,
              kind: input.kind,
              label: input.label,
              subtitle: "",
              schemaVersion: Number(valid.doc.schema_version ?? 1),
              doc,
              origin: "agent",
              originRef: `${input.rolloutId}:${input.toolCallId}`,
              sourcePath: null,
              tags: input.tags
            })
            return {
              result: JSON.stringify({ id: ref.id, entityId: ref.entityId, revision: ref.headRevisionId }),
              effects: [yield* creation(ref.id)]
            }
          })
        ),
      AgentReviseEntity: (input) =>
        receipted(
          input,
          "library.write",
          Effect.gen(function* () {
            yield* checkDocument(input.doc)
            const before = yield* lib.ownedRef(input.userId, input.refId)
            const change = yield* ops.EditRef({
              userId: input.userId,
              refId: input.refId,
              doc: input.doc,
              expectedRowVersion: input.expectedRowVersion,
              message: "Edited in the workshop",
              commitDraft: null,
              agentOriginRef: `${input.rolloutId}:${input.toolCallId}`
            })
            return {
              result: JSON.stringify({ id: change.ref.id, revision: change.ref.headRevisionId }),
              effects:
                change.ref.headRevisionId === before.head_revision_id
                  ? []
                  : [
                      {
                        kind: "library.revise",
                        targetKind: "entity",
                        targetId: before.entity_id,
                        title: `Edited the ${before.kind} ${before.label}`,
                        undo: {
                          refId: before.id,
                          before: before.head_revision_id,
                          exactDocument: before.kind === "preset" || before.kind === "lorebook",
                          archivedAt: before.archived_at,
                          beforeRowVersion: before.row_version,
                          head: change.ref.headRevisionId,
                          rowVersion: change.ref.rowVersion
                        }
                      }
                    ]
            }
          })
        ),
      AgentCloneCard: (input) =>
        receipted(
          input,
          "library.write",
          Effect.gen(function* () {
            const source = yield* lib.ownedRef(input.userId, input.refId)
            // Bound the whole fork before it copies any notes or moves any drafts.
            const [size] = yield* sql<{ n: number; bytes: number; largest: number }>`SELECT count(*) AS n,
              coalesce(sum(length(CAST(h.doc_json AS BLOB)) + (SELECT coalesce(sum(length(CAST(d.content AS BLOB))), 0)
                FROM drafts d WHERE d.user_id = ${input.userId} AND d.target_kind = 'entity_field' AND d.target_id = r.id AND d.status = 'active')), 0) AS bytes,
              coalesce(max(length(CAST(h.doc_json AS BLOB))), 0) AS largest
              FROM entity_refs r JOIN entities e ON e.id = r.entity_id JOIN entity_revisions h ON h.id = r.head_revision_id
              WHERE e.owner_user_id = ${input.userId} AND e.deleted_at IS NULL
                AND (e.id = ${source.entity_id} OR (e.kind = 'note' AND json_extract(h.doc_json, '$.owner.card') = ${source.entity_id}))`
            if (
              size!.n > limits.listItems + 1 ||
              size!.bytes > limits.cloneBytes ||
              size!.largest > limits.documentBytes
            )
              return yield* new EffectUndoRefused({
                message: `A workshop clone allows at most ${limits.listItems} notes, ${limits.documentBytes} bytes per document and ${limits.cloneBytes} bytes in total including drafts. Clone this card in the library instead.`
              })
            const old = yield* sql<{
              id: string
              content: string
              base_revision: string | null
              row_version: number
            }>`SELECT id, content, base_revision, row_version FROM drafts WHERE user_id = ${input.userId} AND target_kind = 'entity_field' AND status = 'active'
        AND target_id IN (SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE e.owner_user_id = ${input.userId} AND (e.id = ${source.entity_id} OR (e.kind = 'note' AND json_extract(h.doc_json, '$.owner.card') = ${source.entity_id})))`
            const ref = yield* ops.ForkCard(input)
            const made = yield* sql<{
              id: RefId
              entity_id: string
            }>`SELECT r.id, r.entity_id FROM entity_refs r JOIN entities e ON e.id = r.entity_id JOIN entity_revisions h ON h.id = r.head_revision_id WHERE e.owner_user_id = ${input.userId}
        AND (e.id = ${ref.entityId} OR (e.kind = 'note' AND json_extract(h.doc_json, '$.owner.card') = ${ref.entityId})) ORDER BY e.kind = 'card' DESC, e.id`
            const effects = []
            for (const row of made) {
              yield* checkDocument(yield* lib.loadDoc((yield* lib.ownedRef(input.userId, row.id)).head_revision_id))
              effects.push(yield* creation(row.id))
            }
            const carries = []
            for (const draft of old) {
              const [now] = yield* sql<{ row_version: number }>`SELECT row_version FROM drafts WHERE id = ${draft.id}`
              if (now && now.row_version !== draft.row_version)
                carries.push({
                  id: draft.id,
                  content: draft.content,
                  base: draft.base_revision,
                  afterVersion: now.row_version
                })
            }
            if (effects[0]) Object.assign(effects[0].undo, { carries })
            return {
              result: JSON.stringify({ id: ref.id, entityId: ref.entityId, revision: ref.headRevisionId }),
              effects
            }
          })
        ),
      AgentStartChat: (input) =>
        receipted(
          input,
          "chats.setup",
          Effect.gen(function* () {
            const greetings = input.greeters.flatMap((greeter) => greeter.options)
            if (
              input.cards.length > limits.castCards ||
              input.greeters.length > limits.castCards ||
              input.greeters.some((greeter) => greeter.options.length > limits.listItems + 1) ||
              greetings.length > limits.effects ||
              greetings.some((greeting) => greeting.text.length > limits.textChars) ||
              Buffer.byteLength(JSON.stringify(input.greeters), "utf8") > limits.cloneBytes
            )
              return yield* new EffectUndoRefused({
                message:
                  "The selected greetings exceed the workshop's setup limits. Start this chat from the library instead."
              })
            const chat = yield* ops.StartGreetingChat(input)
            let binding: {
              connection: import("@rp/shared/providers.ts").ConnectionId
              model: import("@rp/shared/providers.ts").ModelId
            } | null = null
            if (input.model !== null) {
              const [row] = yield* sql<{
                connection_id: import("@rp/shared/providers.ts").ConnectionId
              }>`SELECT m.connection_id FROM models m JOIN connections c ON c.id = m.connection_id WHERE m.id = ${input.model} AND c.owner_user_id = ${input.userId} AND c.deleted_at IS NULL`
              if (!row) return yield* new NotFound({ entity: "model", id: input.model })
              binding = { connection: row.connection_id, model: input.model }
            }
            const events = [
              ...(input.preset === null ? [] : [{ key: "preset.binding" as const, value: { ref: input.preset } }]),
              ...(binding === null ? [] : [{ key: "model.binding" as const, value: binding }])
            ]
            if (events.length)
              yield* ops.AddStateEvents({ userId: input.userId, chatId: chat.id, slotId: null, data: events })
            const [stamp] = yield* chatStamp(sql, input.userId, chat.id)
            return {
              result: JSON.stringify({ chatId: chat.id }),
              effects: [
                {
                  kind: "chat.create",
                  targetKind: "chat",
                  targetId: chat.id,
                  title: `Started the chat ${chat.title}`,
                  undo: { stamp: stamp!.stamp }
                }
              ]
            }
          })
        ),
      CompletePluginUndo: (input) =>
        Effect.gen(function* () {
          yield* owned(input)
          const [row] =
            yield* sql<EffectRow>`SELECT * FROM rollout_effects WHERE rollout_id = ${input.rolloutId} AND tool_call_id = ${input.toolCallId} AND seq = ${input.seq}`
          if (!row || !row.kind.startsWith("plugin.")) return yield* refuse("That plugin change is unavailable.")
          if (row.undone_at === null)
            yield* sql`UPDATE rollout_effects SET undone_at = ${Date.now()}, undo_result_json = ${JSON.stringify(input.result)}
            WHERE rollout_id = ${input.rolloutId} AND tool_call_id = ${input.toolCallId} AND seq = ${input.seq}`
          const [done] =
            yield* sql<EffectRow>`SELECT * FROM rollout_effects WHERE rollout_id = ${input.rolloutId} AND tool_call_id = ${input.toolCallId} AND seq = ${input.seq}`
          return toRolloutEffect(done!)
        }).pipe(transaction(sql, "CompletePluginUndo")),
      UndoRolloutEffect: (input) =>
        Effect.gen(function* () {
          yield* owned(input)
          const [row] =
            yield* sql<EffectRow>`SELECT * FROM rollout_effects WHERE rollout_id = ${input.rolloutId} AND tool_call_id = ${input.toolCallId} AND seq = ${input.seq}`
          if (!row)
            return yield* new NotFound({
              entity: "rollout effect",
              id: `${input.rolloutId}:${input.toolCallId}:${input.seq}`
            })
          return yield* undoRow(input.userId, row)
        }).pipe(transaction(sql, "UndoRolloutEffect")),
      // "Undo all of this reply": one transaction, newest change first. Each undo runs in its own
      // savepoint, so a refused one leaves nothing half done; the first refusal stops the rest,
      // since an older change may be what a newer one built on.
      UndoRolloutEffects: (input) =>
        Effect.gen(function* () {
          yield* owned({ userId: input.userId, rolloutId: input.rolloutId, toolCallId: "" })
          const [inChat] =
            yield* sql`SELECT 1 FROM rollouts WHERE id = ${input.rolloutId} AND chat_id = ${input.chatId}`
          if (!inChat) return yield* new NotFound({ entity: "workshop rollout", id: input.rolloutId })
          const rows = yield* sql<EffectRow>`SELECT * FROM rollout_effects
            WHERE rollout_id = ${input.rolloutId} AND undone_at IS NULL
            ORDER BY created_at DESC, tool_call_id DESC, seq DESC`
          const undone: Array<RolloutEffect> = []
          for (const [at, row] of rows.entries()) {
            const outcome = yield* sql.withTransaction(undoRow(input.userId, row)).pipe(
              Effect.map((effect) => ({ effect }) as const),
              Effect.catchTag(["EffectUndoRefused", "NotFound"], (error) =>
                Effect.succeed({
                  reason: error._tag === "NotFound" ? "What it changed is gone." : (error as EffectUndoRefused).message
                } as const)
              )
            )
            if ("effect" in outcome) {
              undone.push(outcome.effect)
              continue
            }
            return {
              undone,
              refused: { effect: toRolloutEffect(row), reason: outcome.reason },
              left: rows.slice(at + 1).map(toRolloutEffect)
            }
          }
          return { undone, refused: null, left: [] }
        }).pipe(transaction(sql, "UndoRolloutEffects"))
    } satisfies Pick<
      Handlers,
      | "RunWorkshopOperation"
      | "AgentCreateEntity"
      | "AgentReviseEntity"
      | "AgentCloneCard"
      | "AgentStartChat"
      | "CompletePluginUndo"
      | "UndoRolloutEffect"
      | "UndoRolloutEffects"
    >
  })
