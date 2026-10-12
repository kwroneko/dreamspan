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
import type { SqlClient, SqlError } from "effect/sql"
import { DraftTooLarge, NotFound, StaleWrite } from "./ops.ts"

interface DraftRow {
  readonly id: string
  readonly user_id: UserId
  readonly target_kind: DraftKey["targetKind"]
  readonly target_id: string
  readonly field: string
  readonly content: string
  readonly status: Draft["status"]
  readonly base_revision: string | null
  readonly row_version: number
  readonly created_at: number
  readonly updated_at: number
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
    historyLength: row.history_length
  })

const patchOf = (entry: EntryRow): Patch => ({ start: entry.start, removed: entry.removed, inserted: entry.inserted })

/**
 * Applies `patch` to text held as pieces. Slices share the original strings' storage, so
 * a step costs the number of pieces, not the length of the text.
 */
const patchPieces = (pieces: ReadonlyArray<string>, patch: Patch) => {
  const end = patch.start + patch.removed.length
  const out: Array<string> = []
  let at = 0
  let placed = false
  const place = () => {
    if (!placed && patch.inserted !== "") out.push(patch.inserted)
    placed = true
  }
  for (const piece of pieces) {
    const next = at + piece.length
    if (next <= patch.start) out.push(piece)
    else if (at >= end) {
      place()
      out.push(piece)
    } else {
      if (at < patch.start) out.push(piece.slice(0, patch.start - at))
      place()
      if (next > end) out.push(piece.slice(end - at))
    }
    at = next
  }
  place()
  return out
}

/**
 * History walked back from the current text, newest entry first: each entry with the
 * lengths of the text after and before it, which is all destructiveness depends on. The
 * text before an entry is only rebuilt for entries from seq `textFrom` up.
 */
const walkBack = (content: string, newestFirst: ReadonlyArray<EntryRow>, textFrom = Infinity) => {
  let length = content.length
  let pieces: ReadonlyArray<string> = [content]
  return newestFirst.map((entry) => {
    const patch = patchOf(entry)
    const before = length - patch.inserted.length + patch.removed.length
    const rebuilt = entry.seq >= textFrom
    if (rebuilt) pieces = patchPieces(pieces, invertPatch(patch))
    const step = {
      entry,
      after: length,
      before,
      destructive: isDestructive(patch, before),
      textBefore: rebuilt ? pieces : null
    }
    length = before
    return step
  })
}

/** The text from just before each destructive entry that `wanted` picks, newest first. */
const beforeDestructive = (
  content: string,
  newestFirst: ReadonlyArray<EntryRow>,
  wanted: (seq: number) => boolean = () => true
) => {
  const picked = new Set(
    walkBack(content, newestFirst)
      .filter((step) => step.destructive && wanted(step.entry.seq))
      .map((step) => step.entry.seq)
  )
  if (picked.size === 0) return []
  return walkBack(content, newestFirst, Math.min(...picked))
    .filter((step) => picked.has(step.entry.seq))
    .map((step) => step.textBefore!.join(""))
}

/**
 * `recover` is where text a commit or discard would lose goes: the bin's recovered-text
 * section. Only the writer commits or discards drafts.
 */
export const makeDraftStore = (
  sql: SqlClient.SqlClient,
  recover: (
    userId: UserId,
    key: DraftKey,
    texts: ReadonlyArray<string>,
    reason: "commit" | "discard"
  ) => Effect.Effect<void, SqlError.SqlError> = () => Effect.void
) => {
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
      const oldestUndone = walkBack(draft.content, newestFirst, seq + 1).findLast((step) => step.entry.seq > seq)
      return oldestUndone ? oldestUndone.textBefore!.join("") : draft.content
    })

  /** The restorable states, newest first, with what changed to reach each one. */
  const history = (draft: DraftRow, limit: number) =>
    Effect.map(entries(draft.id), (newestFirst) => {
      const steps = walkBack(draft.content, newestFirst)
      const oldest = steps.at(-1)
      const states = steps.map(
        ({ entry, after }) =>
          new DraftState({
            seq: entry.seq,
            at: entry.at,
            length: after,
            removed: excerpt(entry.removed),
            inserted: excerpt(entry.inserted),
            kind: entry.kind
          })
      )
      states.push(
        new DraftState({
          seq: oldest ? oldest.entry.seq - 1 : 0,
          at: oldest ? oldest.entry.first_at : draft.created_at,
          length: oldest ? oldest.before : draft.content.length,
          removed: "",
          inserted: "",
          kind: "initial"
        })
      )
      return states.slice(0, limit)
    })

  /**
   * Drops the oldest entries beyond the retention limits. The text from before a dropped
   * destructive change goes to the recovered-text section first, as a commit would send it.
   */
  const retain = (draft: DraftRow, content: string) =>
    Effect.gen(function* () {
      const sizes = yield* sql<{ seq: number; removed: number; inserted: number }>`
        SELECT seq, length(removed) AS removed, length(inserted) AS inserted
        FROM draft_history WHERE draft_id = ${draft.id} ORDER BY seq DESC`
      let total = 0
      const cut = sizes.findIndex((row, index) => {
        total += row.removed + row.inserted
        return index >= DraftHistoryPolicy.maxEntries || (index > 0 && total > DraftHistoryPolicy.maxHistoryChars)
      })
      if (cut < 0) return
      const cutSeq = sizes[cut]!.seq
      // The text is only loaded if a dropped entry may be destructive. SQLite counts code
      // points, so a UTF-16 length is between one and two times the count. Starting from a
      // lower bound on the text's length and doubling what was removed can only flag
      // more entries than isDestructive would, never fewer.
      let before = content.length / 2
      const mayLoseText = sizes.some((row, index) => {
        before = before - row.inserted + row.removed
        return index >= cut && (2 * row.removed > 200 || 2 * row.removed > before / 2)
      })
      if (mayLoseText) {
        const lost = beforeDestructive(content, yield* entries(draft.id), (seq) => seq <= cutSeq)
        yield* recover(draft.user_id, toDraft(draft).key, lost, "commit")
      }
      yield* sql`DELETE FROM draft_history WHERE draft_id = ${draft.id} AND seq <= ${cutSeq}`
    })

  /** Records `patch` (turning the draft's text into `content`), extending the last entry when typing continues. */
  const record = (draft: DraftRow, content: string, patch: Patch, kind: "edit" | "restore", now: number) =>
    Effect.gen(function* () {
      const [last] =
        yield* sql<EntryRow>`SELECT * FROM draft_history WHERE draft_id = ${draft.id} ORDER BY seq DESC LIMIT 1`
      if (last && kind === "edit" && last.kind === "edit" && draft.status === "active") {
        const lastPatch = patchOf(last)
        const beforeLast = applyPatch(draft.content, invertPatch(lastPatch))
        const continuing =
          now - last.at < DraftHistoryPolicy.coalesceGapMs &&
          now - last.first_at < DraftHistoryPolicy.coalesceSpanMs &&
          !isDestructive(lastPatch, beforeLast.length) &&
          !isDestructive(patch, draft.content.length)
        if (continuing) {
          const merged = diffPatch(beforeLast, content)
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
      yield* retain(draft, content)
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
      // Saving the same text against a new base revision only moves the base.
      const sameBase = baseRevision === null || baseRevision === draft.base_revision
      if (isEmptyPatch(patch) && draft.status === "active" && sameBase) return draft
      if (!isEmptyPatch(patch)) yield* record(draft, content, patch, kind, now)
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

  /**
   * Ends a drafting session. The committed text now lives in a version or revision, so
   * the history is deleted and the draft emptied (owner, 2026-10-10). Text that would be
   * lost goes to the bin's recovered-text section: the text from before each destructive
   * change in the session (hours of typing wiped, then saved), and a discarded draft.
   */
  const end = (draft: DraftRow, outcome: "committed" | "discarded") =>
    Effect.gen(function* () {
      const lost = beforeDestructive(draft.content, yield* entries(draft.id))
      if (outcome === "discarded") lost.unshift(draft.content)
      yield* recover(draft.user_id, toDraft(draft).key, lost, outcome === "discarded" ? "discard" : "commit")
      yield* sql`DELETE FROM draft_history WHERE draft_id = ${draft.id}`
      const updatedAt = Date.now()
      yield* sql`UPDATE drafts SET status = ${outcome}, content = '', row_version = row_version + 1, updated_at = ${updatedAt}
                 WHERE id = ${draft.id}`
      return toDraft({
        ...draft,
        status: outcome,
        content: "",
        row_version: draft.row_version + 1,
        updated_at: updatedAt,
        history_length: 0
      })
    })

  const clear = (userId: UserId, key: DraftKey, outcome: "committed" | "discarded", expectedRowVersion: number) =>
    Effect.gen(function* () {
      const draft = yield* get(userId, key)
      yield* checkVersion(draft, expectedRowVersion)
      return yield* end(draft, outcome)
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
        return yield* end(draft, "committed")
      }
      return toDraft(draft)
    })

  return { find, get, toDraft, listActive, history, stateAt, save, restore, end, clear, commit }
}
