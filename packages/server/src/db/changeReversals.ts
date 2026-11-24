// Revert and Redo of a workshop's library changes (spec/WORKSHOP-CARDS.md §8.1). A revert takes a
// change (B, A) back on the item as it is now (H), field by field (`changeReversal.ts`), as a new
// revision of the user's; a conflict writes nothing. Each is an append-only record in
// `change_reversals` with the changes it covers (`change_reversal_effects`), from which an effect's
// state is derived: `undone_at` stays one-shot Undo's. A card file's revert runs on the files host
// (it's on disk) and records here through `RecordFileReversal`.
import {
  changedUnits,
  docOfUnits,
  matchesReversalHead,
  pickedUnits,
  planGroupedReversal,
  planReversal,
  type ReversalPatch,
  revertedFields,
  type ReversalPlan
} from "@dreamspan/shared/changeReversal.ts"
import {
  keepsRegexApproval,
  validateDoc,
  withHtmlApprovals,
  withoutGrantedAgentEdits
} from "@dreamspan/shared/editing.ts"
import type { Doc, EntityKind, RefId } from "@dreamspan/shared/library.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { EffectUndoRefused, type ReversalOutcome, type RolloutEffect } from "@dreamspan/shared/workshopApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Rpc } from "effect/rpc"
import { makeLibraryQueries } from "./library.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import type { OpsOf } from "./opsOf.ts"
import { query, transaction } from "./tx.ts"
import { toRolloutEffect } from "./workshopEffects.ts"

type Handlers = Parameters<typeof WriteOps.of>[0]
type ReadHandlers = Parameters<typeof ReadOps.of>[0]
type EditRefRpc = Extract<OpsOf<typeof WriteOps>, { readonly _tag: "EditRef" }>
type EditRef = (
  input: Parameters<Handlers["EditRef"]>[0]
) => Effect.Effect<Rpc.Success<EditRefRpc>, Rpc.Error<EditRefRpc> | import("effect/sql").SqlError.SqlError>

interface EffectKey {
  readonly rolloutId: string
  readonly toolCallId: string
  readonly seq: number
}
type EffectRow = Parameters<typeof toRolloutEffect>[0]
interface ReversalRow {
  readonly id: string
  readonly chat_id: string | null
  readonly target_kind: "entity" | "file"
  readonly target_id: string
  readonly label: string
  readonly action: "revert" | "redo"
  readonly reverses_id: string | null
  readonly head_before: string | null
  readonly head_after: string | null
  readonly fields_json: string
  readonly before_json: string
  readonly after_json: string
  readonly created_at: number
}

const refuse = (message: string) => new EffectUndoRefused({ message })
const oldestFirst = (a: EffectRow, b: EffectRow) =>
  a.created_at - b.created_at ||
  a.rollout_id.localeCompare(b.rollout_id) ||
  a.tool_call_id.localeCompare(b.tool_call_id) ||
  a.seq - b.seq

/** The workshop's own changes of the account, by key; one that isn't the account's is not found. */
const ownedEffects = (sql: SqlClient.SqlClient, userId: UserId, keys: ReadonlyArray<EffectKey>) =>
  Effect.gen(function* () {
    const rows: Array<EffectRow & { chat_id: string }> = []
    for (const key of keys) {
      const [row] = yield* sql<EffectRow & { chat_id: string }>`SELECT e.*, r.chat_id FROM rollout_effects e
        JOIN rollouts r ON r.id = e.rollout_id JOIN chats c ON c.id = r.chat_id
        WHERE e.rollout_id = ${key.rolloutId} AND e.tool_call_id = ${key.toolCallId} AND e.seq = ${key.seq}
          AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
      if (!row)
        return yield* new NotFound({ entity: "rollout effect", id: `${key.rolloutId}:${key.toolCallId}:${key.seq}` })
      if (
        !rows.some((r) => r.rollout_id === row.rollout_id && r.tool_call_id === row.tool_call_id && r.seq === row.seq)
      )
        rows.push(row)
    }
    return rows.sort(oldestFirst)
  })

/** Each effect's fields: those of its own change, and those of it this record covers. */
export interface CoveredEffect extends EffectKey {
  readonly of: ReadonlyArray<string>
  readonly fields: ReadonlyArray<string>
}

/** Writes one reversal record and its effects (inside the caller's transaction). */
export const insertReversal = (
  sql: SqlClient.SqlClient,
  record: {
    readonly userId: UserId
    readonly chatId: string | null
    readonly targetKind: "entity" | "file"
    readonly targetId: string
    readonly label: string
    readonly action: "revert" | "redo"
    readonly reversesId: string | null
    readonly headBefore: string | null
    readonly headAfter: string | null
    readonly plan: Pick<ReversalPlan, "fields" | "before" | "after">
    readonly effects: ReadonlyArray<CoveredEffect>
  }
) =>
  Effect.gen(function* () {
    const id = uuidv7()
    yield* sql`INSERT INTO change_reversals (id, user_id, chat_id, target_kind, target_id, label, action, reverses_id,
        head_before, head_after, fields_json, before_json, after_json, created_at)
      VALUES (${id}, ${record.userId}, ${record.chatId}, ${record.targetKind}, ${record.targetId}, ${record.label},
        ${record.action}, ${record.reversesId}, ${record.headBefore}, ${record.headAfter},
        ${JSON.stringify(record.plan.fields)}, ${JSON.stringify(record.plan.before)}, ${JSON.stringify(record.plan.after)}, ${Date.now()})`
    for (const effect of record.effects) {
      const fields = effect.fields.filter((f) => record.plan.fields.includes(f))
      if (fields.length === 0) continue
      yield* sql`INSERT INTO change_reversal_effects (reversal_id, rollout_id, tool_call_id, seq, fields_json, of_json)
        VALUES (${id}, ${effect.rolloutId}, ${effect.toolCallId}, ${effect.seq}, ${JSON.stringify(fields)}, ${JSON.stringify(effect.of)})`
    }
    return id
  })

/**
 * The effects with their reversal state (`reversion`), from their records oldest first: the
 * fields whose latest record is a revert, all their fields, and the reverts holding those.
 */
export const withReversions = (sql: SqlClient.SqlClient, effects: ReadonlyArray<RolloutEffect>) =>
  Effect.gen(function* () {
    const relevant = effects.filter((e) => e.kind === "library.revise" || e.kind === "file.edit")
    if (relevant.length === 0) return effects
    const rows = yield* sql<{
      rollout_id: string
      tool_call_id: string
      seq: number
      fields_json: string
      of_json: string
      id: string
      action: "revert" | "redo"
    }>`SELECT e.rollout_id, e.tool_call_id, e.seq, e.fields_json, e.of_json, r.id, r.action
      FROM change_reversal_effects e JOIN change_reversals r ON r.id = e.reversal_id
      WHERE e.rollout_id IN ${sql.in([...new Set(relevant.map((e) => e.rolloutId))])}
      ORDER BY r.created_at, r.rowid`
    if (rows.length === 0) return effects
    return effects.map((effect) => {
      const own = rows.filter(
        (r) => r.rollout_id === effect.rolloutId && r.tool_call_id === effect.toolCallId && r.seq === effect.seq
      )
      if (own.length === 0) return effect
      const records = own.map((r) => ({
        id: r.id,
        action: r.action,
        fields: JSON.parse(r.fields_json) as Array<string>
      }))
      const standing = revertedFields(records)
      // The revert each standing field's latest record is, newest first.
      const holding = new Set<string>()
      for (const field of standing) {
        const last = records.findLast((r) => r.fields.includes(field))
        if (last) holding.add(last.id)
      }
      return {
        ...effect,
        reversion: {
          fields: [...standing],
          of: JSON.parse(own.at(-1)!.of_json) as Array<string>,
          reversals: records
            .filter((r) => holding.has(r.id))
            .map((r) => r.id)
            .reverse()
        }
      }
    })
  })

/** The approvals a revert never gives (as a restored revision, editorWrites.ts `RestoreRevision`). */
export const guarded = (kind: EntityKind, head: Doc, next: Doc): Doc => {
  let doc = withoutGrantedAgentEdits(kind, head, next)
  if (kind === "preset" || kind === "card") {
    if (doc.regex_approved === true && !keepsRegexApproval(head, doc)) doc = { ...doc, regex_approved: false }
    doc = withHtmlApprovals(head, doc)
  }
  return doc
}

interface Options {
  readonly fields?: ReadonlyArray<string> | undefined
  readonly choices?: Readonly<Record<string, "now" | "before">> | undefined
  readonly expectedHead?: string | undefined
  readonly dryRun?: boolean | undefined
  readonly message?: string | undefined
}

const outcome = (plan: ReversalPlan, head: string, reversalId: string | null = null): ReversalOutcome => ({
  reversalId,
  head,
  fields: plan.fields,
  conflicts: plan.conflicts.map((c) => ({
    field: c.field,
    ...(c.now === undefined ? {} : { now: c.now }),
    ...(c.before === undefined ? {} : { before: c.before })
  }))
})

/**
 * The assistant's revert of one revision's change (spec/WORKSHOP-CARDS.md §9 `revert_change`): the
 * change from its first parent to it, planned on the item as it is now, and the workshop's own
 * changes that made exactly that revision (so their rows say Reverted). Read-only: the caller
 * writes, in its own transaction.
 */
export const revisionReversal = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  ref: { readonly id: string; readonly entity_id: string; readonly head_revision_id: string },
  revisionId: string,
  names: ReadonlyArray<string> | undefined
) =>
  Effect.gen(function* () {
    const [revision] = yield* sql<{ parents: string; doc_json: string }>`SELECT parents, doc_json
      FROM entity_revisions WHERE id = ${revisionId} AND entity_id = ${ref.entity_id}`
    if (!revision) return yield* new NotFound({ entity: "revision", id: revisionId })
    const parent = (JSON.parse(revision.parents) as Array<string>)[0]
    if (parent === undefined) return yield* refuse("That's the item's first revision: it has no change to take back.")
    const [before] = yield* sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions WHERE id = ${parent}`
    if (!before) return yield* refuse("Its earlier revision is gone.")
    const [head] = yield* sql<{
      doc_json: string
    }>`SELECT doc_json FROM entity_revisions WHERE id = ${ref.head_revision_id}`
    const original = JSON.parse(before.doc_json) as Doc
    const changed = JSON.parse(revision.doc_json) as Doc
    const units = changedUnits(original, changed)
    const plan = planReversal({
      original,
      changed,
      now: JSON.parse(head!.doc_json) as Doc,
      fields: pickedUnits(units, names)
    })
    const made = yield* sql<EffectRow & { chat_id: string }>`SELECT e.*, r.chat_id FROM rollout_effects e
      JOIN rollouts r ON r.id = e.rollout_id JOIN chats c ON c.id = r.chat_id
      WHERE c.owner_user_id = ${userId} AND e.kind = 'library.revise' AND e.target_id = ${ref.entity_id} AND e.undone_at IS NULL
        AND json_extract(e.undo_json, '$.head') = ${revisionId} AND json_extract(e.undo_json, '$.before') = ${parent}`
    const covered: Array<CoveredEffect> = made.map((row) => ({
      rolloutId: row.rollout_id,
      toolCallId: row.tool_call_id,
      seq: row.seq,
      of: units,
      fields: units
    }))
    return { plan, covered, chatId: made[0]?.chat_id ?? null }
  })

export const makeChangeReversalWriteHandlers = (ops: { readonly EditRef: EditRef }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lib = makeLibraryQueries(sql)
    const revisionDoc = (entityId: string, revisionId: unknown) =>
      Effect.gen(function* () {
        if (typeof revisionId !== "string") return yield* refuse("This change has no earlier revision to go back to.")
        const [row] = yield* sql<{
          doc_json: string
        }>`SELECT doc_json FROM entity_revisions WHERE id = ${revisionId} AND entity_id = ${entityId}`
        if (!row) return yield* refuse("Its earlier revision is gone.")
        return JSON.parse(row.doc_json) as Doc
      })

    /** Takes `plan` into the item as a new revision and records it; a dry run or conflict writes nothing. */
    const apply = (
      userId: UserId,
      ref: Effect.Success<ReturnType<typeof lib.ownedRef>>,
      plan: ReversalPlan,
      options: Options,
      record: Omit<
        Parameters<typeof insertReversal>[1],
        "userId" | "targetKind" | "targetId" | "label" | "headBefore" | "headAfter" | "plan"
      >,
      defaultMessage: string
    ) =>
      Effect.gen(function* () {
        const headId = ref.head_revision_id
        if (
          plan.doc === null ||
          options.dryRun === true ||
          plan.fields.length === 0 ||
          !matchesReversalHead(headId, options)
        )
          return outcome(plan, headId)
        const head = yield* lib.loadDoc(ref.head_revision_id)
        const valid = validateDoc(ref.kind, guarded(ref.kind, head, plan.doc as Doc))
        if (!valid.ok) return yield* refuse(`It can't be reverted: ${valid.problems.join(" ")}`)
        const change = yield* ops
          .EditRef({
            userId,
            refId: ref.id as RefId,
            expectedRowVersion: ref.row_version,
            doc: valid.doc,
            message: options.message?.trim() || defaultMessage,
            commitDraft: null
          })
          .pipe(
            Effect.catchTag(["StaleWrite", "InvalidDocument"], () =>
              Effect.fail(refuse("It changed while reverting. Try again."))
            )
          )
        const id = yield* insertReversal(sql, {
          ...record,
          userId,
          targetKind: "entity",
          targetId: ref.entity_id,
          label: change.ref.label,
          headBefore: ref.head_revision_id,
          headAfter: change.ref.headRevisionId,
          plan
        })
        return outcome(plan, headId, id)
      })

    return {
      RevertLibraryChange: ({ userId, effects: keys, ...options }) =>
        Effect.gen(function* () {
          const rows = (yield* ownedEffects(sql, userId, keys)).filter((r) => r.undone_at === null)
          if (rows.length === 0) return yield* refuse("This change was undone already.")
          const first = rows[0]!
          if (rows.some((r) => r.kind !== "library.revise" || r.target_id !== first.target_id))
            return yield* refuse("Only edits of one library item are reverted together.")
          const effects = rows.map(toRolloutEffect)
          const refId = String(effects[0]!.undo?.refId)
          const ref = yield* lib.ownedRef(userId, refId)
          if (ref.entity_id !== first.target_id) return yield* new NotFound({ entity: "ref", id: refId })
          if (effects.some((effect) => effect.undo?.refId !== refId))
            return yield* refuse("Only edits of one library ref are reverted together.")
          // The ref version orders its writes even when two effect timestamps tie.
          const ordered = effects.toSorted((a, b) => Number(a.undo!.rowVersion) - Number(b.undo!.rowVersion))
          const standing = yield* withReversions(sql, ordered)
          const covered: Array<CoveredEffect> = []
          const patches: Array<ReversalPatch> = []
          for (const effect of standing) {
            const original = yield* revisionDoc(ref.entity_id, effect.undo!.before)
            const changed = yield* revisionDoc(ref.entity_id, effect.undo!.head)
            const of = changedUnits(original, changed)
            const fields = of.filter(
              (unit) => !effect.reversion?.fields.includes(unit) && (!options.fields || options.fields.includes(unit))
            )
            patches.push({ original, changed, fields })
            covered.push({ rolloutId: effect.rolloutId, toolCallId: effect.toolCallId, seq: effect.seq, of, fields })
          }
          const plan = planGroupedReversal(
            patches.reverse(),
            yield* lib.loadDoc(ref.head_revision_id),
            matchesReversalHead(ref.head_revision_id, options) ? options.choices : undefined
          )
          return yield* apply(
            userId,
            ref,
            plan,
            options,
            { chatId: first.chat_id, action: "revert", reversesId: null, effects: covered },
            "Reverted the assistant's change"
          )
        }).pipe(transaction(sql, "RevertLibraryChange")),

      RedoLibraryChange: ({ userId, reversalId, ...options }) =>
        Effect.gen(function* () {
          const [record] = yield* sql<ReversalRow>`SELECT * FROM change_reversals
            WHERE id = ${reversalId} AND user_id = ${userId} AND action = 'revert' AND target_kind = 'entity'`
          if (!record) return yield* new NotFound({ entity: "revert", id: reversalId })
          // The ref the reverted changes edited, as their recipes name it.
          const [ref] = yield* sql<{ id: string | null }>`SELECT json_extract(e.undo_json, '$.refId') AS id
            FROM change_reversal_effects x JOIN rollout_effects e
              ON e.rollout_id = x.rollout_id AND e.tool_call_id = x.tool_call_id AND e.seq = x.seq
            WHERE x.reversal_id = ${record.id} LIMIT 1`
          if (!ref?.id) return yield* new NotFound({ entity: "ref", id: record.target_id })
          const head = yield* lib.ownedRef(userId, ref.id)
          if (head.entity_id !== record.target_id) return yield* new NotFound({ entity: "ref", id: ref.id })
          const recorded = JSON.parse(record.fields_json) as Array<string>
          const fields = options.fields ? recorded.filter((f) => options.fields!.includes(f)) : recorded
          const plan = planReversal({
            original:
              record.head_before === null
                ? docOfUnits(JSON.parse(record.before_json) as Record<string, unknown>)
                : yield* revisionDoc(record.target_id, record.head_before),
            changed:
              record.head_after === null
                ? docOfUnits(JSON.parse(record.after_json) as Record<string, unknown>)
                : yield* revisionDoc(record.target_id, record.head_after),
            now: yield* lib.loadDoc(head.head_revision_id),
            fields,
            ...(options.choices && matchesReversalHead(head.head_revision_id, options)
              ? { choices: options.choices }
              : {})
          })
          const effects = yield* sql<{
            rollout_id: string
            tool_call_id: string
            seq: number
            fields_json: string
            of_json: string
          }>`SELECT * FROM change_reversal_effects WHERE reversal_id = ${record.id}`
          return yield* apply(
            userId,
            head,
            plan,
            options,
            {
              chatId: record.chat_id,
              action: "redo",
              reversesId: record.id,
              effects: effects.map((e) => ({
                rolloutId: e.rollout_id,
                toolCallId: e.tool_call_id,
                seq: e.seq,
                of: JSON.parse(e.of_json) as Array<string>,
                fields: JSON.parse(e.fields_json) as Array<string>
              }))
            },
            "Redid the assistant's change"
          )
        }).pipe(transaction(sql, "RedoLibraryChange")),

      // The files host wrote the card file back; this records what it took back, in one transaction.
      RecordFileReversal: ({
        userId,
        path,
        label,
        action,
        reversesId,
        headBefore,
        headAfter,
        fields,
        before,
        after,
        effects
      }) =>
        Effect.gen(function* () {
          const rows = yield* ownedEffects(sql, userId, effects)
          if (rows.some((r) => r.kind !== "file.edit" || r.target_id !== path))
            return yield* refuse("Only edits of one card file are reverted together.")
          if (reversesId !== null) {
            const [reverted] = yield* sql`SELECT 1 FROM change_reversals
              WHERE id = ${reversesId} AND user_id = ${userId} AND action = 'revert' AND target_kind = 'file' AND target_id = ${path}`
            if (!reverted) return yield* new NotFound({ entity: "revert", id: reversesId })
          }
          return yield* insertReversal(sql, {
            userId,
            chatId: rows[0]?.chat_id ?? null,
            targetKind: "file",
            targetId: path,
            label,
            action,
            reversesId,
            headBefore,
            headAfter,
            plan: { fields, before, after },
            effects
          })
        }).pipe(transaction(sql, "RecordFileReversal"))
    } satisfies Pick<Handlers, "RevertLibraryChange" | "RedoLibraryChange" | "RecordFileReversal">
  })

export const makeChangeReversalReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    /** One revert of the account's card file, with the changes it covers: the host's Redo reads it. */
    FileReversal: ({ userId, reversalId }) =>
      Effect.gen(function* () {
        const [record] = yield* sql<ReversalRow>`SELECT * FROM change_reversals
          WHERE id = ${reversalId} AND user_id = ${userId} AND action = 'revert'`
        if (!record) return yield* new NotFound({ entity: "revert", id: reversalId })
        const effects = yield* sql<{
          rollout_id: string
          tool_call_id: string
          seq: number
          fields_json: string
          of_json: string
        }>`SELECT * FROM change_reversal_effects WHERE reversal_id = ${record.id}`
        return {
          id: record.id,
          targetKind: record.target_kind,
          targetId: record.target_id,
          label: record.label,
          fields: JSON.parse(record.fields_json) as Array<string>,
          before: JSON.parse(record.before_json) as Record<string, unknown>,
          after: JSON.parse(record.after_json) as Record<string, unknown>,
          effects: effects.map((e) => ({
            rolloutId: e.rollout_id,
            toolCallId: e.tool_call_id,
            seq: e.seq,
            of: JSON.parse(e.of_json) as Array<string>,
            fields: JSON.parse(e.fields_json) as Array<string>
          }))
        }
      }).pipe(query("FileReversal")),
    /**
     * The workshop's reverts and redos since its last finished reply (spec/WORKSHOP-CARDS.md §8.2):
     * what the next turn's tail line tells the assistant, once.
     */
    ChatReversalsSince: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [last] = yield* sql<{ at: number | null }>`SELECT max(r.completed_at) AS at FROM rollouts r
          JOIN chats c ON c.id = r.chat_id WHERE r.chat_id = ${chatId} AND c.owner_user_id = ${userId}`
        const rows = yield* sql<ReversalRow & { kind: string }>`SELECT r.*,
            coalesce((SELECT e.kind FROM entities e WHERE e.id = r.target_id AND r.target_kind = 'entity'), 'card') AS kind
          FROM change_reversals r
          WHERE r.user_id = ${userId} AND r.chat_id = ${chatId} AND r.created_at > ${last?.at ?? 0}
            -- The assistant's own revert_change is in its transcript already, not the user's to tell.
            AND NOT EXISTS (SELECT 1 FROM entity_revisions v WHERE v.id = r.head_after AND v.origin = 'agent')
          ORDER BY r.created_at, r.rowid`
        // Items the reply made that Undo moved to the bin since.
        const binned = yield* sql<{ title: string }>`SELECT e.title FROM rollout_effects e
          JOIN rollouts r ON r.id = e.rollout_id JOIN chats c ON c.id = r.chat_id
          WHERE r.chat_id = ${chatId} AND c.owner_user_id = ${userId} AND e.kind = 'library.create'
            AND e.undone_at > ${last?.at ?? 0}
          ORDER BY e.undone_at`
        return {
          reversals: rows.map((r) => ({
            action: r.action,
            targetKind: r.target_kind,
            kind: r.kind,
            label: r.label,
            fields: JSON.parse(r.fields_json) as Array<string>
          })),
          binned: binned.flatMap((b) => {
            const name = /^Created the (?:card|lorebook|preset) (.*)$/s.exec(b.title)?.[1]
            return name ? [name] : []
          })
        }
      }).pipe(query("ChatReversalsSince"))
  } satisfies Pick<ReadHandlers, "FileReversal" | "ChatReversalsSince">
})
