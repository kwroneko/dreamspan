// Draft storage shared by the writer and the readers (DESIGN §6.2). See
// @rp/shared/drafts.ts for the patch model.
import type { UserId } from "@rp/shared/domain.ts"
import {
  applyPatch,
  diffPatch,
  Draft,
  DraftHistoryPolicy,
  type DraftKey,
  DraftState,
  excerpt,
  invertPatch,
  isDestructive,
  isEmptyPatch,
  type Patch
} from "@rp/shared/drafts.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { DraftTooLarge, NotFound, StaleWrite } from "./ops.ts"

interface DraftRow {
  readonly id: string
  readonly target_kind: DraftKey["targetKind"]
  readonly target_id: string
  readonly field: string
  readonly content: string
  readonly status: Draft["status"]
  readonly base_revision: string | null
  readonly row_version: number
  readonly created_at: number
  readonly updated_at: number
  readonly recovery_text: string | null
  readonly recovery_at: number | null
  readonly history_length: number
}

interface EntryRow {
  readonly seq: number
  readonly kind: "edit" | "restore"
  readonly first_at: number
  readonly at: number
  readonly start: number
  readonly removed: string
  readonly inserted: string
}

const toDraft = (row: DraftRow) =>
  new Draft({
    id: row.id,
    key: { targetKind: row.target_kind, targetId: row.target_id, field: row.field },
    content: row.content,
    status: row.status,
    baseRevision: row.base_revision,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    historyLength: row.history_length,
    recovery: row.recovery_text !== null ? { content: row.recovery_text, at: row.recovery_at ?? row.updated_at } : null
  })

const patchOf = (entry: EntryRow): Patch => ({ start: entry.start, removed: entry.removed, inserted: entry.inserted })

export const makeDraftStore = (sql: SqlClient.SqlClient) => {
  const find = (userId: UserId, key: DraftKey) =>
    sql<DraftRow>`
      SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
      FROM drafts d
      WHERE d.user_id = ${userId} AND d.target_kind = ${key.targetKind} AND d.target_id = ${key.targetId}
        AND d.field = ${key.field}`.pipe(Effect.map(([row]) => row ?? null))

  const get = (userId: UserId, key: DraftKey) =>
    Effect.flatMap(find(userId, key), (row) =>
      row
        ? Effect.succeed(row)
        : Effect.fail(new NotFound({ entity: "draft", id: `${key.targetKind}:${key.targetId}` }))
    )

  const entries = (draftId: string) =>
    sql<EntryRow>`SELECT * FROM draft_history WHERE draft_id = ${draftId} ORDER BY seq DESC`

  const listActive = (userId: UserId) =>
    sql<DraftRow>`
      SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
      FROM drafts d WHERE d.user_id = ${userId} AND d.status = 'active' AND d.content <> ''
      ORDER BY d.updated_at DESC`.pipe(Effect.map((rows) => rows.map(toDraft)))

  /** The text of state `seq`: the current text with newer entries undone. */
  const stateAt = (draft: DraftRow, seq: number) =>
    Effect.gen(function* () {
      const newestFirst = yield* entries(draft.id)
      const newest = newestFirst[0]?.seq ?? 0
      const oldestReachable = (newestFirst.at(-1)?.seq ?? 1) - 1
      if (seq > newest || seq < oldestReachable) {
        return yield* new NotFound({ entity: "draft state", id: String(seq) })
      }
      let content = draft.content
      for (const entry of newestFirst) {
        if (entry.seq <= seq) break
        content = applyPatch(content, invertPatch(patchOf(entry)))
      }
      return content
    })

  /** The restorable states, newest first, with what changed to reach each one. */
  const history = (draft: DraftRow, limit: number) =>
    Effect.gen(function* () {
      const newestFirst = yield* entries(draft.id)
      const states: Array<DraftState> = []
      let length = draft.content.length
      for (const entry of newestFirst) {
        states.push(
          new DraftState({
            seq: entry.seq,
            at: entry.at,
            length,
            removed: excerpt(entry.removed),
            inserted: excerpt(entry.inserted),
            kind: entry.kind
          })
        )
        length = length - entry.inserted.length + entry.removed.length
      }
      const oldest = newestFirst.at(-1)
      states.push(
        new DraftState({
          seq: oldest ? oldest.seq - 1 : 0,
          at: oldest ? oldest.first_at : draft.created_at,
          length,
          removed: "",
          inserted: "",
          kind: "initial"
        })
      )
      return states.slice(0, limit)
    })

  /** Drops the oldest entries beyond the retention limits. */
  const retain = (draftId: string) =>
    Effect.gen(function* () {
      const sizes = yield* sql<{ seq: number; n: number }>`
        SELECT seq, length(removed) + length(inserted) AS n FROM draft_history WHERE draft_id = ${draftId} ORDER BY seq DESC`
      let total = 0
      const keep = sizes.findIndex((row, index) => {
        total += row.n
        return index >= DraftHistoryPolicy.maxEntries || (index > 0 && total > DraftHistoryPolicy.maxHistoryChars)
      })
      if (keep >= 0) yield* sql`DELETE FROM draft_history WHERE draft_id = ${draftId} AND seq <= ${sizes[keep]!.seq}`
    })

  /** Records `patch` (turning `before` into the new text), extending the last entry when typing continues. */
  const record = (draft: DraftRow, before: string, patch: Patch, kind: "edit" | "restore", now: number) =>
    Effect.gen(function* () {
      const [last] =
        yield* sql<EntryRow>`SELECT * FROM draft_history WHERE draft_id = ${draft.id} ORDER BY seq DESC LIMIT 1`
      if (last && kind === "edit" && last.kind === "edit" && draft.status === "active") {
        const lastPatch = patchOf(last)
        const beforeLast = applyPatch(before, invertPatch(lastPatch))
        const continuing =
          now - last.at < DraftHistoryPolicy.coalesceGapMs &&
          now - last.first_at < DraftHistoryPolicy.coalesceSpanMs &&
          !isDestructive(lastPatch, beforeLast) &&
          !isDestructive(patch, before)
        if (continuing) {
          const merged = diffPatch(beforeLast, applyPatch(before, patch))
          if (isEmptyPatch(merged)) {
            yield* sql`DELETE FROM draft_history WHERE draft_id = ${draft.id} AND seq = ${last.seq}`
          } else {
            yield* sql`UPDATE draft_history SET start = ${merged.start}, removed = ${merged.removed},
                         inserted = ${merged.inserted}, at = ${now}
                       WHERE draft_id = ${draft.id} AND seq = ${last.seq}`
          }
          return
        }
      }
      yield* sql`INSERT INTO draft_history ${sql.insert({
        draft_id: draft.id,
        seq: (last?.seq ?? 0) + 1,
        kind,
        first_at: now,
        at: now,
        start: patch.start,
        removed: patch.removed,
        inserted: patch.inserted
      })}`
      yield* retain(draft.id)
    })

  const checkVersion = (draft: DraftRow, expected: number) =>
    draft.row_version === expected
      ? Effect.void
      : Effect.fail(new StaleWrite({ entity: "draft", id: draft.id, expected, actual: draft.row_version }))

  /** Moves the draft to `content`, recording the change, and returns the saved draft. */
  const update = (draft: DraftRow, content: string, kind: "edit" | "restore", baseRevision: string | null) =>
    Effect.gen(function* () {
      const now = Date.now()
      const patch = diffPatch(draft.content, content)
      if (isEmptyPatch(patch) && draft.status === "active") return draft
      if (!isEmptyPatch(patch)) yield* record(draft, draft.content, patch, kind, now)
      // A save after a commit or discard starts a new drafting session.
      const reopened = draft.status !== "active"
      yield* sql`UPDATE drafts SET content = ${content}, status = 'active',
                   base_revision = ${reopened ? baseRevision : (baseRevision ?? draft.base_revision)},
                   row_version = row_version + 1, updated_at = ${now}
                 WHERE id = ${draft.id}`
      return draft
    })

  const save = (options: {
    readonly userId: UserId
    readonly key: DraftKey
    readonly content: string
    readonly expectedRowVersion: number | null
    readonly baseRevision: string | null
    readonly checkTarget: Effect.Effect<void, NotFound, never>
  }) =>
    Effect.gen(function* () {
      if (options.content.length > DraftHistoryPolicy.maxContentChars) {
        return yield* new DraftTooLarge({ length: options.content.length, max: DraftHistoryPolicy.maxContentChars })
      }
      const existing = yield* find(options.userId, options.key)
      if (existing === null) {
        if (options.expectedRowVersion !== null) {
          return yield* new StaleWrite({
            entity: "draft",
            id: options.key.targetId,
            expected: options.expectedRowVersion,
            actual: 0
          })
        }
        yield* options.checkTarget
        const now = Date.now()
        yield* sql`INSERT INTO drafts ${sql.insert({
          id: uuidv7(),
          user_id: options.userId,
          target_kind: options.key.targetKind,
          target_id: options.key.targetId,
          field: options.key.field,
          content: options.content,
          base_revision: options.baseRevision,
          status: "active",
          created_at: now,
          updated_at: now
        })}`
      } else {
        if (options.expectedRowVersion === null) {
          return yield* new StaleWrite({ entity: "draft", id: existing.id, expected: 0, actual: existing.row_version })
        }
        yield* checkVersion(existing, options.expectedRowVersion)
        yield* update(existing, options.content, "edit", options.baseRevision)
      }
      return toDraft((yield* find(options.userId, options.key))!)
    })

  const restore = (userId: UserId, key: DraftKey, seq: number, expectedRowVersion: number) =>
    Effect.gen(function* () {
      const draft = yield* get(userId, key)
      yield* checkVersion(draft, expectedRowVersion)
      const content = yield* stateAt(draft, seq)
      yield* update(draft, content, "restore", null)
      return toDraft((yield* find(userId, key))!)
    })

  /** The text from just before the newest destructive change in the history, if any. */
  const beforeLastDestructive = (draft: DraftRow) =>
    Effect.gen(function* () {
      let after = draft.content
      for (const entry of yield* entries(draft.id)) {
        const patch = patchOf(entry)
        const before = applyPatch(after, invertPatch(patch))
        if (isDestructive(patch, before)) return before
        after = before
      }
      return null
    })

  /**
   * Ends a drafting session. The history has served its purpose, since the committed
   * text now lives in a version or revision, so it's deleted and the text emptied
   * (owner, 2026-10-10). Kept: the one text a wipe-then-send would lose, or the
   * discarded text, as `recovery`.
   */
  const clear = (userId: UserId, key: DraftKey, outcome: "committed" | "discarded", expectedRowVersion: number) =>
    Effect.gen(function* () {
      const draft = yield* get(userId, key)
      yield* checkVersion(draft, expectedRowVersion)
      const recovery = outcome === "discarded" ? draft.content || null : yield* beforeLastDestructive(draft)
      const now = Date.now()
      yield* sql`DELETE FROM draft_history WHERE draft_id = ${draft.id}`
      yield* sql`UPDATE drafts SET status = ${outcome}, content = '', recovery_text = ${recovery},
                   recovery_at = ${recovery === null ? null : now}, row_version = row_version + 1, updated_at = ${now}
                 WHERE id = ${draft.id}`
      return toDraft((yield* find(userId, key))!)
    })

  /**
   * For writes that commit a draft: marks it committed if it's still the version the
   * client sent from. Otherwise it's left active, since it holds newer text.
   */
  const commit = (
    userId: UserId,
    commitDraft: { readonly key: DraftKey; readonly expectedRowVersion: number } | null
  ) =>
    Effect.gen(function* () {
      if (commitDraft === null) return null
      const draft = yield* find(userId, commitDraft.key)
      if (draft === null) return null
      if (draft.row_version === commitDraft.expectedRowVersion && draft.status === "active") {
        // Checked just above, so neither NotFound nor StaleWrite can happen here.
        return yield* Effect.orDie(clear(userId, commitDraft.key, "committed", commitDraft.expectedRowVersion))
      }
      return toDraft(draft)
    })

  return { find, get, toDraft, listActive, history, stateAt, save, restore, clear, commit }
}
