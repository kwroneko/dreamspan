import { historyFork } from "./historyShared.ts"
import { onForkPath } from "./forks.ts"
import { chatKinds } from "@rp/shared/chatKinds.ts"
// Worker-only undo policies for operation exposures. No non-database work in a transaction.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { makeRegistry } from "@rp/shared/registry.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { User } from "@rp/shared/domain.ts"
import type { ChatId, SlotId, ForkId } from "@rp/shared/chat.ts"
import { foldState } from "@rp/shared/state.ts"
import { settingsRegistry, readSetting, writeSetting } from "./settings.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import type { Rpc } from "effect/rpc"
import type { OpsOf } from "./opsOf.ts"
import type { Doc, RefId } from "@rp/shared/library.ts"
import type { StoredStateEventData } from "@rp/shared/state.ts"
import { EffectUndoRefused } from "@rp/shared/workshopApi.ts"
import { makeLibraryQueries } from "./library.ts"

export const refuseOperation = (message: string) => new EffectUndoRefused({ message })
type Handlers = Parameters<typeof WriteOps.of>[0]
type WriteRpc<K> = Extract<OpsOf<typeof WriteOps>, { readonly _tag: K }>
type Input<K extends keyof Handlers> = Rpc.Payload<WriteRpc<K>>
export type OperationHandlers = {
  [K in keyof Handlers]: (input: Input<K>) => Effect.Effect<Rpc.Success<WriteRpc<K>>, unknown>
}
interface Policy<I, B> {
  readonly id: string
  readonly capability: string
  readonly label: string
  readonly kind: string
  readonly targetKind: string
  readonly target: (input: I, after: B) => string
  readonly before: (sql: SqlClient.SqlClient, userId: UserId, input: I) => Effect.Effect<B, unknown>
  /** Compare saved target state; a policy may exclude metadata that ordinary use updates. */
  readonly matches?: (current: B, expected: B) => boolean
  readonly undo: (
    sql: SqlClient.SqlClient,
    ops: OperationHandlers,
    userId: UserId,
    input: I,
    before: B,
    after: B
  ) => Effect.Effect<unknown, unknown>
}
// Each policy stays typed. Only the heterogeneous registry erases its input and snapshot types.
export type OperationPolicy = Policy<never, never>
const policy = <I, B>(entry: Policy<I, B>): OperationPolicy => entry as unknown as OperationPolicy
export const operationSnapshotMatches = (entry: OperationPolicy, current: unknown, expected: unknown) =>
  entry.matches
    ? entry.matches(current as never, expected as never)
    : JSON.stringify(current) === JSON.stringify(expected)
interface ChatSnapshot {
  id: ChatId
  title: string
  kind: string
  title_source: string
  row_version: number
  state_seq: number
  current_fork_id: ForkId | null
  active_leaf_slot_id: SlotId | null
}
const snapshotChat = (sql: SqlClient.SqlClient, userId: UserId, chatId: string) =>
  Effect.gen(function* () {
    const [row] =
      yield* sql<ChatSnapshot>`SELECT id, title, kind, title_source, row_version, state_seq, current_fork_id, active_leaf_slot_id
    FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
    if (!row) return yield* new NotFound({ entity: "chat", id: chatId })
    return row
  })
const settingRows = (sql: SqlClient.SqlClient, userId: UserId, keys: readonly string[]) =>
  Effect.forEach(keys, (key) => readSetting(sql, "user", userId, key).pipe(Effect.map((row) => ({ key, ...row }))))
const restoreSettings = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  before: ReadonlyArray<{ key: string; value: unknown; revision: number }>,
  after: ReadonlyArray<{ key: string; value: unknown; revision: number }>
) =>
  Effect.gen(function* () {
    for (const row of before) {
      const next = after.find((r) => r.key === row.key)
      const current = yield* readSetting(sql, "user", userId, row.key)
      if (current.revision !== next!.revision)
        return yield* refuseOperation("This setting changed since. Open settings before undoing it.")
      if (row.revision === 0)
        yield* sql`DELETE FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = ${row.key}`
      else yield* writeSetting(sql, "user", userId, row.key, row.value, current.revision)
    }
    return {}
  })
const settingsPolicy = (
  id: string,
  keys: readonly string[],
  capability = "settings",
  label = "Changed settings"
): OperationPolicy =>
  policy<{ key?: string }, Effect.Success<ReturnType<typeof settingRows>>>({
    id,
    capability,
    label,
    kind: "setting.set",
    targetKind: "setting",
    target: (input) => input.key ?? keys.join(", "),
    before: (sql, userId, input) => settingRows(sql, userId, keys.length ? keys : [input.key!]),
    undo: (sql, _ops, userId, _input, before, after) => restoreSettings(sql, userId, before, after)
  })
const refSnapshot = (sql: SqlClient.SqlClient, userId: UserId, input: { refId: RefId }) =>
  Effect.gen(function* () {
    const ref = yield* makeLibraryQueries(sql).ownedRef(userId, input.refId)
    const [entity] = yield* sql<{
      archived_at: number | null
    }>`SELECT archived_at FROM entities WHERE id = ${ref.entity_id}`
    return { ref, archived: entity!.archived_at }
  })
type RefSnapshot = Effect.Success<ReturnType<typeof refSnapshot>>
const refSnapshotMatches = (current: RefSnapshot, expected: RefSnapshot) => {
  // Keep complete snapshots in the receipt. Using a preset updates this timestamp
  // without changing its document or version, and Undo must retain that usage record.
  const target = (snapshot: RefSnapshot) => ({ ...snapshot, ref: { ...snapshot.ref, last_used_at: null } })
  return JSON.stringify(target(current)) === JSON.stringify(target(expected))
}
/** Undo may restore only an immutable revision of this owned entry, even if a
 * stored recipe is malformed. The caller already checks the current saved head. */
export const previousLibraryDocument = (sql: SqlClient.SqlClient, userId: UserId, refId: string, revisionId: string) =>
  sql<{ doc_json: string }>`SELECT v.doc_json FROM entity_revisions v
    JOIN entity_refs r ON r.entity_id = v.entity_id JOIN entities e ON e.id = r.entity_id
    WHERE r.id = ${refId} AND v.id = ${revisionId} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL`.pipe(
    Effect.flatMap(([row]) =>
      row
        ? Effect.succeed(JSON.parse(row.doc_json) as Doc)
        : Effect.fail(refuseOperation("The previous document is unavailable for this entry."))
    )
  )
const refPolicy = (id: string): OperationPolicy =>
  policy<{ refId: RefId }, Effect.Success<ReturnType<typeof refSnapshot>>>({
    id,
    label:
      (
        {
          RenameRef: "Renamed a library entry",
          SetRefArchived: "Changed a library entry's archive status",
          RestoreRevision: "Restored a library revision"
        } as Record<string, string>
      )[id] ?? "Changed a library entry",
    capability: "library.write",
    kind: "library.revise",
    targetKind: "entity",
    target: (_input, after) => after.ref.entity_id,
    before: refSnapshot,
    matches: refSnapshotMatches,
    undo: (sql, ops, userId, input, before, after) =>
      Effect.gen(function* () {
        const now = yield* refSnapshot(sql, userId, input)
        if (!refSnapshotMatches(now, after))
          return yield* refuseOperation("The library entry changed since. Open its history.")
        if (before.ref.head_revision_id !== after.ref.head_revision_id)
          if (before.ref.kind === "preset" || before.ref.kind === "lorebook")
            yield* ops.EditRef!({
              userId,
              refId: input.refId,
              expectedRowVersion: now.ref.row_version,
              doc: yield* previousLibraryDocument(sql, userId, input.refId, before.ref.head_revision_id),
              message: "Undid a workshop change",
              commitDraft: null
            })
          else
            yield* ops.RestoreRevision!({
              userId,
              refId: input.refId,
              revisionId: before.ref.head_revision_id as never,
              expectedRowVersion: now.ref.row_version
            })
        yield* sql`UPDATE entity_refs SET label = ${before.ref.label}, subtitle = ${before.ref.subtitle},
      row_version = row_version + 1, updated_at = ${Date.now()} WHERE id = ${input.refId}`
        yield* sql`UPDATE entities SET archived_at = ${before.archived} WHERE id = ${before.ref.entity_id}`
        const restored = yield* makeLibraryQueries(sql).ownedRef(userId, input.refId)
        return { restoredHead: restored.head_revision_id, restoredRowVersion: restored.row_version }
      })
  })
type StateInput = {
  displayEnd?: boolean
  chatId: ChatId
  slotId: SlotId | null
  forkId: ForkId | null
  /** A role's own setting (the summary model's "summarizer"); undo restores only chat-wide ones. */
  scope?: string | null
  data: typeof StoredStateEventData.Type | ReadonlyArray<typeof StoredStateEventData.Type>
}
const stateSnapshot = (sql: SqlClient.SqlClient, userId: UserId, input: StateInput) =>
  Effect.gen(function* () {
    const chat = yield* snapshotChat(sql, userId, input.chatId)
    const rows = yield* stateEventsThrough(sql, input.chatId, input.slotId, input.forkId)
    return {
      chat,
      state: foldState(
        rows.map((r) => ({ scope: r.scope, data: { key: r.key, value: JSON.parse(r.value_json) } })) as never
      )
    }
  })
const allowedStateKeys = new Set([
  "participant.join",
  "participant.leave",
  "played_by_me.set",
  "model.binding",
  "preset.binding",
  "lorebook.attach",
  "lorebook.detach",
  "lorebook.embedded",
  "agent.enabled",
  "agent.tools",
  "cards.rotation",
  "reply.order",
  "card.swap"
])
const statePolicy = (id: string): OperationPolicy =>
  policy<StateInput, Effect.Success<ReturnType<typeof stateSnapshot>>>({
    id,
    label: "Changed a chat's cast or settings",
    capability: "chats.setup",
    kind: "chat.change",
    targetKind: "chat",
    target: (input) => input.chatId,
    before: (sql, userId, input) =>
      Effect.gen(function* () {
        const changes = (Array.isArray(input.data) ? input.data : [input.data]) as ReadonlyArray<
          typeof StoredStateEventData.Type
        >
        if (changes.some((c) => !allowedStateKeys.has(c.key)) || (input.scope ?? null) !== null)
          return yield* refuseOperation("This chat change is not exposed to tools.")
        return yield* stateSnapshot(sql, userId, input)
      }),
    undo: (sql, ops, userId, input, before, after) =>
      Effect.gen(function* () {
        const old = before.state
        const now = after.state
        const data: Array<typeof StoredStateEventData.Type> = []
        const push = (key: string, value: unknown) => data.push({ key, value } as typeof StoredStateEventData.Type)
        // Reverse swaps before restoring membership, preserving historical graph and event rows.
        const changes = (Array.isArray(input.data) ? input.data : [input.data]) as ReadonlyArray<
          typeof StoredStateEventData.Type
        >
        for (const c of [...changes].reverse())
          if (c.key === "card.swap") push("card.swap", { entity: c.value.replaces, replaces: c.value.entity })
        if (
          JSON.stringify(old.participants) !== JSON.stringify(now.participants) ||
          changes.some((c) => c.key === "card.swap")
        ) {
          for (const id of new Set([...now.participants, ...old.participants]))
            push("participant.leave", { entity: id })
          for (const id of old.participants) push("participant.join", { entity: id })
        }
        push("played_by_me.set", { entities: old.playedByMe })
        for (const id of old.participants) push("presence.set", { entity: id, present: !old.absent.includes(id) })
        for (const c of changes) {
          if (c.key === "model.binding")
            push(old.modelBindings[""] ? "model.binding" : "model.unbind", old.modelBindings[""] ?? {})
          if (c.key === "preset.binding")
            push(old.presetBindings[""] ? "preset.binding" : "preset.unbind", old.presetBindings[""] ?? {})
          if (c.key === "lorebook.embedded")
            push(c.key, { entity: c.value.entity, on: old.embeddedLorebooks[c.value.entity] ?? true })
          if (c.key === "lorebook.attach" || c.key === "lorebook.detach") {
            const previous = old.listedLorebooks.find((r) => r.ref === c.value.ref)
            push(previous ? (previous.on ? "lorebook.attach" : "lorebook.detach") : "lorebook.remove", c.value)
          }
          if (c.key === "agent.enabled") push(c.key, { on: old.agentEnabled ?? false })
          // null: the chat followed the app default, and does again.
          if (c.key === "agent.tools") push(c.key, { tools: old.agentTools })
          if (c.key === "cards.rotation") push(c.key, { on: old.cardsRotation ?? false })
          if (c.key === "reply.order") push(c.key, old.replyOrder ?? "natural")
        }
        yield* ops.AddStateEvents!({
          userId,
          chatId: input.chatId,
          forkId: input.forkId,
          slotId: input.slotId,
          displayEnd: input.displayEnd !== false,
          data
        })
        return {}
      })
  })
const ownTurnSnapshot = (sql: SqlClient.SqlClient, userId: UserId, input: { cardRefId: RefId }) =>
  Effect.gen(function* () {
    const card = yield* refSnapshot(sql, userId, { refId: input.cardRefId })
    const notes = yield* sql<{
      id: string
      head: string
      row_version: number
      draft: string
    }>`SELECT r.id, r.head_revision_id AS head, r.row_version,
      (SELECT coalesce(json_group_array(json_array(id, row_version)), '[]') FROM
        (SELECT id, row_version FROM drafts WHERE user_id = ${userId} AND target_id = r.id AND target_kind = 'entity_field' AND status = 'active' ORDER BY id)) AS draft
      FROM entity_refs r JOIN entities e ON e.id = r.entity_id JOIN entity_revisions h ON h.id = r.head_revision_id
      WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
        AND json_extract(h.doc_json, '$.owner.card') = ${card.ref.entity_id} ORDER BY r.id`
    const edits = yield* sql<{ id: string }>`SELECT DISTINCT i.group_id AS id FROM library_edit_items i
      JOIN entity_refs r ON r.id = i.ref_id JOIN entities e ON e.id = r.entity_id
      JOIN entity_revisions h ON h.id = r.head_revision_id JOIN entity_revisions a ON a.id = i.after_revision_id
      WHERE e.owner_user_id = ${userId} AND json_extract(h.doc_json, '$.owner.card') = ${card.ref.entity_id}
        AND json_extract(CASE WHEN json_valid(a.origin_ref) THEN a.origin_ref ELSE '{}' END, '$.ownTurnMove') = i.group_id ORDER BY i.group_id`
    return { card, notes, edits }
  })

export const operationPolicies = makeRegistry<OperationPolicy>([
  policy<Input<"MoveToOwnTurnNote">, Effect.Success<ReturnType<typeof ownTurnSnapshot>>>({
    id: "MoveToOwnTurnNote",
    label: "Moved card text to an own-turn note",
    capability: "library.write",
    kind: "changeset.apply",
    targetKind: "entity",
    target: (_input, after) => after.card.ref.entity_id,
    before: ownTurnSnapshot,
    undo: (_sql, ops, userId, _input, before, after) =>
      Effect.gen(function* () {
        for (const edit of after.edits.filter((edit) => !before.edits.some((old) => old.id === edit.id))) {
          const result = yield* ops.UndoLibraryEdit({ userId, editId: edit.id })
          if (result.kept.length) return yield* refuseOperation("A moved note changed since. Open its History.")
        }
        return {}
      })
  }),
  settingsPolicy("SetAgentSetting", []),
  statePolicy("AddStateEvent"),
  statePolicy("AddStateEvents"),
  settingsPolicy("ChangeGenerationDefaults", [
    "chat.persona",
    "generation.model",
    "generation.preset",
    "generation.judge",
    "generation.lcm"
  ]),
  settingsPolicy("SetCardFavourite", ["cards.favourites"], "library.write", "Changed card favourites"),
  refPolicy("RenameRef"),
  refPolicy("SetRefArchived"),
  refPolicy("RestoreRevision"),
  policy<Input<"RenameChats">, Effect.Success<ReturnType<typeof snapshotChat>>>({
    id: "RenameChats",
    label: "Renamed a chat",
    capability: "chats.setup",
    kind: "chat.change",
    targetKind: "chat",
    target: (input) => input.chats[0]!.chatId,
    before: (sql, userId, input) =>
      Effect.gen(function* () {
        if (input.chats.length !== 1) return yield* refuseOperation("Rename one chat at a time so it can be undone.")
        return yield* snapshotChat(sql, userId, input.chats[0]!.chatId)
      }),
    undo: (sql, _ops, userId, input, before, after) =>
      Effect.gen(function* () {
        const now = yield* snapshotChat(sql, userId, input.chats[0]!.chatId)
        if (JSON.stringify(now) !== JSON.stringify(after))
          return yield* refuseOperation("This chat changed since. Open it before undoing the rename.")
        yield* sql`UPDATE chats SET title = ${before.title}, title_source = ${before.title_source}, row_version = row_version + 1 WHERE id = ${before.id}`
        return {}
      })
  }),
  policy<
    Input<"ApplyHistoryEdits">,
    Array<{ chat: ChatSnapshot; records: ReadonlyArray<{ id: string; status: string }> }>
  >({
    id: "ApplyHistoryEdits",
    label: "Renamed text in history",
    capability: "chats.rewrite",
    kind: "changeset.apply",
    targetKind: "chat",
    target: (input) => input.applications[0]!.chatId,
    before: (sql, userId, input) =>
      Effect.forEach(input.applications, (application) =>
        Effect.gen(function* () {
          const chat = yield* snapshotChat(sql, userId, application.chatId)
          const running =
            yield* sql`SELECT 1 FROM versions v JOIN slots s ON s.id = v.slot_id WHERE s.chat_id = ${chat.id} AND v.status = 'generating'`
          if (running.length) return yield* refuseOperation("That chat is writing a reply. Try again when it finishes.")
          const records = yield* sql<{
            id: string
            status: string
          }>`SELECT id, status FROM changesets WHERE chat_id = ${chat.id} AND fork_id = ${application.forkId} ORDER BY id`
          return { chat, records }
        })
      ),
    undo: (_sql, ops, userId, input, before, after) =>
      Effect.gen(function* () {
        for (let i = 0; i < after.length; i++)
          for (const record of after[i]!.records) {
            if (before[i]!.records.some((r) => r.id === record.id)) continue
            const result = yield* ops.UndoHistoryEdit!({
              userId,
              chatId: input.applications[i]!.chatId,
              forkId: input.applications[i]!.forkId,
              changesetId: record.id
            })
            if (result.conflicts.length)
              return yield* refuseOperation("Some history changed since. Open History edits to undo it.")
          }
        return {}
      })
  }),
  policy<Input<"SendOrQueue">, ChatSnapshot>({
    id: "SendOrQueue",
    label: "Generated a reply",
    capability: "generate",
    kind: "reply.generate",
    targetKind: "chat",
    target: (input) => input.chatId,
    before: (sql, userId, input) =>
      Effect.gen(function* () {
        if (input.kind !== "generate" || input.branch || input.round?.length || input.autoPick)
          return yield* refuseOperation("Only one explicit reply in the chosen chat is allowed.")
        const chat = yield* snapshotChat(sql, userId, input.chatId)
        if (chatKinds.get(chat.kind)?.allowsOutside !== false)
          return yield* refuseOperation("Replies in another workshop or an unavailable chat kind are not allowed.")
        const queued = yield* sql`SELECT 1 FROM queued_messages WHERE chat_id = ${chat.id}
          AND (fork_id IS ${input.forkId ?? chat.current_fork_id} OR fork_id IS NULL) LIMIT 1`
        if (queued.length)
          return yield* refuseOperation(
            "That chat has queued messages or a saved round. Finish or clear it there before asking for a reply; Undo cannot restore its queue."
          )
        return chat
      }),
    undo: (sql, ops, userId, input, before, after) =>
      Effect.gen(function* () {
        const [version] =
          yield* sql`SELECT id FROM versions WHERE slot_id = ${after.active_leaf_slot_id} AND status = 'generating'`
        if (version) return yield* refuseOperation("That reply is still being written. Stop it before undoing.")
        yield* ops.DeleteMessage!({ userId, slotId: after.active_leaf_slot_id!, forkId: after.current_fork_id })
        return { note: "The reply is in the bin. The provider request cannot be unsent." }
      })
  }),
  policy<Input<"SetChatPin">, boolean>({
    id: "SetChatPin",
    label: "Changed a chat pin",
    capability: "chats.setup",
    kind: "chat.change",
    targetKind: "chat",
    target: (input) => input.chatId,
    before: (sql, userId, input) =>
      Effect.gen(function* () {
        yield* snapshotChat(sql, userId, input.chatId)
        return (yield* sql`SELECT 1 FROM chat_pins WHERE user_id = ${userId} AND chat_id = ${input.chatId}`).length > 0
      }),
    undo: (_sql, ops, userId, input, before) =>
      ops.SetChatPin!({ userId, chatId: input.chatId, pinned: before, leaf: input.leaf }).pipe(Effect.as({}))
  })
])

export const operationInfo = (
  sql: SqlClient.SqlClient,
  input: { userId: UserId; chatId?: ChatId; storyAt?: import("@rp/shared/chat.ts").StoryAt }
) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{
      id: string
      handle: string
      display_name: string
      role: "user" | "admin"
    }>`SELECT id, handle, display_name, role FROM users WHERE id = ${input.userId} AND disabled_at IS NULL`
    if (!row) return yield* new NotFound({ entity: "user", id: input.userId })
    const settings = yield* Effect.forEach(
      settingsRegistry.list().filter((e) => e.scope === "user" && e.agent),
      (entry) =>
        readSetting(sql, "user", input.userId, entry.id).pipe(
          Effect.map((value) => ({ key: entry.id, description: entry.agent!.description, ...value }))
        )
    )
    let proof: unknown = null
    if (input.chatId) {
      const chat = yield* snapshotChat(sql, input.userId, input.chatId)
      if (input.storyAt) {
        const at = input.storyAt
        const fork = yield* historyFork(sql, input.userId, input.chatId, at.forkId)
        if (
          at.chatId !== input.chatId ||
          (at.leafSlotId !== null && !(yield* onForkPath(sql, input.chatId, fork, at.leafSlotId)))
        )
          return yield* new NotFound({ entity: "story position", id: at.forkId })
      }
      const rows = yield* stateEventsThrough(
        sql,
        input.chatId,
        input.storyAt ? input.storyAt.leafSlotId : (chat.active_leaf_slot_id as SlotId | null),
        input.storyAt ? input.storyAt.forkId : chat.current_fork_id
      )
      const state = foldState(
        rows.map((r) => ({ scope: r.scope, data: { key: r.key, value: JSON.parse(r.value_json) } })) as never
      )
      const chosen = (state.modelBindings[""] ??
        (yield* readSetting(sql, "user", input.userId, "generation.model")).value) as {
        readonly connection: string
        readonly model: string
      } | null
      const [provider] = chosen
        ? yield* sql`SELECT c.row_version AS connectionRevision, c.cache_revision AS connectionCacheRevision,
          m.row_version AS modelRevision FROM connections c JOIN models m ON m.connection_id = c.id
          WHERE c.id = ${chosen.connection} AND m.id = ${chosen.model} AND c.owner_user_id = ${input.userId}
          AND c.deleted_at IS NULL AND c.purged_at IS NULL`
        : []
      proof = { ...chat, model: chosen, provider: provider ?? null }
    }
    return {
      user: new User({ id: input.userId, handle: row.handle, displayName: row.display_name, role: row.role }),
      settings,
      proof
    }
  })
