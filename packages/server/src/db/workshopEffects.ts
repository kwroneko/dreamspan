// Setup tools compose the same typed user operations in one outer writer transaction.
// The receipt and all undo recipes commit with them. No external work occurs here.
import { EffectUndoRefused, type RolloutEffect } from "@rp/shared/workshopApi.ts"
import { newCardDoc, validateDoc, withoutGrantedAgentEdits, withHtmlApprovals } from "@rp/shared/editing.ts"
import { InvalidDocument } from "@rp/shared/editorApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Rpc, RpcGroup } from "effect/rpc"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeRegistry } from "@rp/shared/registry.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import type { Bin } from "./bin.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { makeLibraryQueries } from "./library.ts"
import { transaction } from "./tx.ts"

type Handlers = Parameters<typeof WriteOps.of>[0]
type OperationName =
  "CreateEntity" | "EditRef" | "ForkCard" | "RestoreRevision" | "StartGreetingChat" | "AddStateEvents"
type OperationRpc<K> = Extract<RpcGroup.Rpcs<typeof WriteOps>, { readonly _tag: K }>
type Operations = {
  [K in OperationName]: (
    input: Parameters<Handlers[K]>[0]
  ) => Effect.Effect<Rpc.Success<OperationRpc<K>>, Rpc.Error<OperationRpc<K>> | import("effect/sql").SqlError.SqlError>
}
type Key = { readonly userId: UserId; readonly rolloutId: string; readonly toolCallId: string }
interface EffectRow {
  rollout_id: string
  tool_call_id: string
  seq: number
  kind: string
  target_kind: string
  target_id: string
  title: string
  undo_json: string | null
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
  undoneAt: row.undone_at,
  createdAt: row.created_at
})

// Undo policies are replaceable worker registrations; the transaction/ownership boundary is kernel.
interface Undoer {
  readonly id: string
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

// A reverse-order undo restores content through new revisions. Only those known restores
// may advance a previous effect's expected head; a user's intervening edit still refuses.
const checkedRef = (ctx: UndoContext, effect: RolloutEffect) =>
  Effect.gen(function* () {
    const undo = effect.undo!
    const ref = yield* makeLibraryQueries(ctx.sql).ownedRef(ctx.userId, String(undo.refId))
    let head = String(undo.head)
    let version = Number(undo.rowVersion)
    const restored = yield* ctx.sql<{ undo_json: string }>`SELECT undo_json FROM rollout_effects
    WHERE target_kind = 'entity' AND target_id = ${effect.targetId} AND kind = 'library.revise' AND undone_at IS NOT NULL ORDER BY undone_at, created_at DESC`
    // A chain may have been undone at the same millisecond. Follow edges rather than clock order.
    const remaining = restored.map((r) => JSON.parse(r.undo_json) as Record<string, unknown>)
    for (;;) {
      const at = remaining.findIndex(
        (r) => r.before === head && Number(r.beforeRowVersion) === version && typeof r.restoredHead === "string"
      )
      if (at < 0) break
      const [edge] = remaining.splice(at, 1)
      head = String(edge!.restoredHead)
      version = Number(edge!.restoredRowVersion)
    }
    if (ref.entity_id !== effect.targetId || ref.head_revision_id !== head || ref.row_version !== version)
      return yield* refuse()
    return ref
  })

const createUndoer: Undoer = {
  id: "library.create",
  run: (ctx, effect) =>
    Effect.gen(function* () {
      const ref = yield* checkedRef(ctx, effect)
      const undo = effect.undo!
      const [meta] = yield* ctx.sql<{ archived_at: number | null; tags: string; lineage: string }>`SELECT e.archived_at,
      (SELECT coalesce(json_group_array(tag), '[]') FROM (SELECT tag FROM entity_tags WHERE entity_id = e.id ORDER BY tag)) AS tags,
      json_array(e.forked_from_entity_id, e.forked_from_revision_id, e.forked_in_chat_id, e.forked_at) AS lineage
      FROM entities e WHERE e.id = ${effect.targetId}`
      if (!meta || meta.archived_at !== undo.archivedAt || meta.tags !== undo.tags || meta.lineage !== undo.lineage)
        return yield* refuse()
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
      const drafts = yield* ctx.sql<{
        n: number
      }>`SELECT count(*) AS n FROM drafts WHERE target_kind = 'entity_field' AND target_id = ${ref.id}`
      const [draftStamp] = yield* ctx.sql<{
        stamp: string
      }>`SELECT coalesce(json_group_array(json_array(id, row_version)), '[]') AS stamp FROM (SELECT id, row_version FROM drafts WHERE target_kind = 'entity_field' AND target_id = ${ref.id} ORDER BY id)`
      if (drafts[0]!.n > 0 && draftStamp!.stamp !== undo.draftStamp)
        return yield* refuse("Unsaved text on the new item changed since; open its editor first.")
      // Use the bin's ordinary delete, without capacity eviction: undo never purges history.
      yield* ctx.bin.deleteEntity(ctx.userId, ref.entity_id)
      return undo
    })
}
const reviseUndoer: Undoer = {
  id: "library.revise",
  run: (ctx, effect) =>
    Effect.gen(function* () {
      const ref = yield* checkedRef(ctx, effect)
      const change = yield* ctx.ops.RestoreRevision({
        userId: ctx.userId,
        refId: ref.id as RefId,
        revisionId: String(effect.undo!.before) as RevisionId,
        expectedRowVersion: ref.row_version
      })
      return { ...effect.undo!, restoredHead: change.ref.headRevisionId, restoredRowVersion: change.ref.rowVersion }
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
  run: (ctx, effect) =>
    Effect.gen(function* () {
      const [chat] = yield* chatStamp(ctx.sql, ctx.userId, effect.targetId)
      if (!chat || chat.stamp !== effect.undo!.stamp) return yield* refuse()
      yield* ctx.bin.deleteChat(ctx.userId, effect.targetId)
      return effect.undo!
    })
}
export const rolloutUndoers = makeRegistry<Undoer>([createUndoer, reviseUndoer, chatUndoer])

export const makeWorkshopEffectHandlers = (ops: Operations, bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lib = makeLibraryQueries(sql)
    const owned = (key: Key) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ status: string }>`SELECT r.status FROM rollouts r JOIN chats c ON c.id = r.chat_id
      WHERE r.id = ${key.rolloutId} AND c.owner_user_id = ${key.userId} AND c.kind = 'workshop' AND r.kind = 'workshop' AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "workshop rollout", id: key.rolloutId })
        return row
      })
    const receipted = <E>(
      key: Key,
      body: Effect.Effect<
        {
          result: string
          effects: ReadonlyArray<Omit<RolloutEffect, "rolloutId" | "toolCallId" | "seq" | "undoneAt" | "createdAt">>
        },
        E
      >
    ) =>
      Effect.gen(function* () {
        const rollout = yield* owned(key)
        const [receipt] = yield* sql<{
          result_json: string
        }>`SELECT result_json FROM rollout_receipts WHERE rollout_id = ${key.rolloutId} AND tool_call_id = ${key.toolCallId}`
        if (receipt) return JSON.parse(receipt.result_json) as string
        if (!["running", "created"].includes(rollout.status))
          return yield* new EffectUndoRefused({ message: "This workshop run is no longer running." })
        const { result, effects } = yield* body
        const at = Date.now()
        yield* sql`INSERT INTO rollout_receipts ${sql.insert({ rollout_id: key.rolloutId, tool_call_id: key.toolCallId, result_json: JSON.stringify(result), created_at: at })}`
        for (const [seq, effect] of effects.entries())
          yield* sql`INSERT INTO rollout_effects ${sql.insert({ rollout_id: key.rolloutId, tool_call_id: key.toolCallId, seq, kind: effect.kind, target_kind: effect.targetKind, target_id: effect.targetId, title: effect.title, undo_json: effect.undo === null ? null : JSON.stringify(effect.undo), created_at: at })}`
        return result
      }).pipe(transaction(sql, "WorkshopEffect"))
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
            draftStamp: meta!.draftStamp
          }
        }
      })
    return {
      AgentCreateEntity: (input) =>
        receipted(
          input,
          Effect.gen(function* () {
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
            const { ref } = yield* ops.CreateEntity({
              userId: input.userId,
              kind: input.kind,
              label: input.label,
              subtitle: "",
              schemaVersion: Number(valid.doc.schema_version ?? 1),
              doc: valid.doc,
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
          Effect.gen(function* () {
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
          Effect.gen(function* () {
            const source = yield* lib.ownedRef(input.userId, input.refId)
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
            for (const row of made) effects.push(yield* creation(row.id))
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
          Effect.gen(function* () {
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
          if (row.undone_at !== null) return toRolloutEffect(row)
          const undoer = rolloutUndoers.get(row.kind)
          if (!undoer || row.undo_json === null)
            return yield* new EffectUndoRefused({ message: "This change cannot be undone here." })
          const undo = yield* undoer
            .run({ sql, userId: input.userId, ops, bin }, toRolloutEffect(row))
            .pipe(
              Effect.catchTag(["StaleWrite", "InvalidDocument", "RefOperationRefused"], () => Effect.fail(refuse()))
            )
          const at = Date.now()
          yield* sql`UPDATE rollout_effects SET undone_at = ${at}, undo_json = ${JSON.stringify(undo)} WHERE rollout_id = ${input.rolloutId} AND tool_call_id = ${input.toolCallId} AND seq = ${input.seq}`
          return toRolloutEffect({ ...row, undone_at: at, undo_json: JSON.stringify(undo) })
        }).pipe(transaction(sql, "UndoRolloutEffect"))
    } satisfies Pick<
      Handlers,
      "AgentCreateEntity" | "AgentReviseEntity" | "AgentCloneCard" | "AgentStartChat" | "UndoRolloutEffect"
    >
  })
