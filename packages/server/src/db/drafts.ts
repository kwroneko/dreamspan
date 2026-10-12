// Draft storage shared by the writer and the readers (DESIGN §6.2). See
// @rp/shared/drafts.ts for the patch model.
import type { UserId } from "@rp/shared/domain.ts"
import {
  applyPatch,
  composerKey,
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
  readonly session: number
  readonly text_version: number
  readonly created_at: number
  readonly updated_at: number
  readonly history_length: number
}

/** A draft as a client had it when it typed: the row version, and the session if it knows it. */
interface Base {
  readonly rowVersion: number
  readonly session?: number | undefined
}

interface EntryRow {
  readonly seq: number
  readonly kind: "edit" | "restore"
  readonly first_at: number
  readonly at: number
  readonly start: number
  readonly removed: string
  readonly inserted: string
  /** Saved over another tab's text: the text before it is kept, whatever its size. */
  readonly displaced: 0 | 1
}

const toDraft = (row: DraftRow) =>
  new Draft({
    id: row.id,
    key: { targetKind: row.target_kind, targetId: row.target_id, field: row.field },
    content: row.content,
    status: row.status,
    baseRevision: row.base_revision,
    rowVersion: row.row_version,
    session: row.session,
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
 * text before an entry is only rebuilt for entries from seq `textFrom` up. `kept`: the text
 * before the entry must outlive the history (a destructive change, or another tab's text).
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
      kept: entry.displaced === 1 || isDestructive(patch, before),
      textBefore: rebuilt ? pieces : null
    }
    length = before
    return step
  })
}

/** The text from just before each kept entry that `wanted` picks, newest first. */
const beforeKept = (
  content: string,
  newestFirst: ReadonlyArray<EntryRow>,
  wanted: (seq: number) => boolean = () => true
) => {
  const picked = new Set(
    walkBack(content, newestFirst)
      .filter((step) => step.kept && wanted(step.entry.seq))
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

  const byId = (id: string) =>
    sql<DraftRow>`
      SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
      FROM drafts d WHERE d.id = ${id}`.pipe(Effect.map(([row]) => row ?? null))

  /** A chat's composer draft by its id, wherever its tip is now. */
  const findComposer = (userId: UserId, chatId: string, draftId: string) =>
    sql<DraftRow>`
      SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
      FROM drafts d
      WHERE d.id = ${draftId} AND d.user_id = ${userId} AND d.target_kind = 'composer'
        AND d.target_id = ${chatId}`.pipe(Effect.map(([row]) => row ?? null))

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
      const sizes = yield* sql<{ seq: number; removed: number; inserted: number; displaced: 0 | 1 }>`
        SELECT seq, length(removed) AS removed, length(inserted) AS inserted, displaced
        FROM draft_history WHERE draft_id = ${draft.id} ORDER BY seq DESC`
      let total = 0
      const cut = sizes.findIndex((row, index) => {
        total += row.removed + row.inserted
        return index >= DraftHistoryPolicy.maxEntries || (index > 0 && total > DraftHistoryPolicy.maxHistoryChars)
      })
      if (cut < 0) return
      const cutSeq = sizes[cut]!.seq
      // The text is only loaded if a dropped entry is displaced or may be destructive. SQLite
      // counts code points, so a UTF-16 length is between one and two times the count.
      // Starting from a lower bound on the text's length and doubling what was removed can
      // only flag more entries than isDestructive would, never fewer.
      let before = content.length / 2
      const mayLoseText = sizes.some((row, index) => {
        before = before - row.inserted + row.removed
        return index >= cut && (row.displaced === 1 || 2 * row.removed > 200 || 2 * row.removed > before / 2)
      })
      if (mayLoseText) {
        const lost = beforeKept(content, yield* entries(draft.id), (seq) => seq <= cutSeq)
        yield* recover(draft.user_id, toDraft(draft).key, lost, "commit")
      }
      yield* sql`DELETE FROM draft_history WHERE draft_id = ${draft.id} AND seq <= ${cutSeq}`
    })

  /**
   * Records `patch` (turning the draft's text into `content`), extending the last entry when
   * typing continues. One saved over another tab's text (`displaced`) never extends one.
   */
  const record = (
    draft: DraftRow,
    content: string,
    patch: Patch,
    kind: "edit" | "restore",
    now: number,
    displaced: boolean
  ) =>
    Effect.gen(function* () {
      const [last] =
        yield* sql<EntryRow>`SELECT * FROM draft_history WHERE draft_id = ${draft.id} ORDER BY seq DESC LIMIT 1`
      if (last && !displaced && kind === "edit" && last.kind === "edit" && draft.status === "active") {
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
        inserted: patch.inserted,
        displaced: displaced ? 1 : 0
      })}`
      yield* retain(draft, content)
    })

  const checkVersion = (draft: DraftRow, expected: number) =>
    draft.row_version === expected
      ? Effect.void
      : Effect.fail(new StaleWrite({ entity: "draft", id: draft.id, expected, actual: draft.row_version }))

  /** Moves the draft to `content`, recording the change, and returns the saved draft. */
  const update = (
    draft: DraftRow,
    content: string,
    kind: "edit" | "restore",
    baseRevision: string | null,
    displaced = false
  ) =>
    Effect.gen(function* () {
      const now = Date.now()
      const patch = diffPatch(draft.content, content)
      // Saving the same text against a new base revision only moves the base.
      const sameBase = baseRevision === null || baseRevision === draft.base_revision
      if (isEmptyPatch(patch) && draft.status === "active" && sameBase) return draft
      if (!isEmptyPatch(patch)) yield* record(draft, content, patch, kind, now, displaced)
      // A save after a commit or discard starts a new drafting session.
      const reopened = draft.status !== "active"
      const textChanged = reopened || !isEmptyPatch(patch)
      yield* sql`UPDATE drafts SET content = ${content}, status = 'active',
                   base_revision = ${reopened ? baseRevision : (baseRevision ?? draft.base_revision)},
                   row_version = row_version + 1,
                   text_version = CASE WHEN ${textChanged ? 1 : 0} THEN row_version + 1 ELSE text_version END,
                   updated_at = ${now}
                 WHERE id = ${draft.id}`
      return draft
    })

  const insert = (userId: UserId, key: DraftKey, content: string, baseRevision: string | null) => {
    const now = Date.now()
    return sql`INSERT INTO drafts ${sql.insert({
      id: uuidv7(),
      user_id: userId,
      target_kind: key.targetKind,
      target_id: key.targetId,
      field: key.field,
      content,
      base_revision: baseRevision,
      status: "active",
      created_at: now,
      updated_at: now
    })}`
  }

  const tooLarge = (content: string) =>
    content.length > DraftHistoryPolicy.maxContentChars
      ? Effect.fail(new DraftTooLarge({ length: content.length, max: DraftHistoryPolicy.maxContentChars }))
      : Effect.void

  const shown = (draft: DraftRow | null) => (draft?.status === "active" ? draft.content : "")

  /**
   * The one rule for text saved onto a draft, every kind, in the writer's transaction.
   * `base` is the draft as the client had it when the text was typed (null: it had none; no
   * session: the client didn't say, and none is taken to have ended).
   * - Typed on the draft as it is: saved, extending the history as typing does.
   * - Another tab changed the text since (or it's `next`, see below): saved as its own
   *   history entry, the other text before it marked displaced, so it's one step back now
   *   and goes to the recovered texts when the session ends or the entry is dropped.
   * - The session it was typed in has ended since (sent, committed, discarded): `ended`
   *   decides. "recover" (the composer: its text was sent) puts the text in the recovered
   *   texts and leaves the draft alone; "reopen" (a field: an alternative edit, caught by
   *   the edit conflict on commit) starts the next session with it.
   * `next` is composer text typed after a send of this session that may not have arrived:
   * it reopens the session the send ended, or goes on top of the text the send would take.
   */
  const saveOnto = (
    draft: DraftRow,
    base: Base | null,
    content: string,
    options: { readonly baseRevision: string | null; readonly ended: "recover" | "reopen"; readonly next?: boolean }
  ) =>
    Effect.gen(function* () {
      const ended = base?.session !== undefined && base.session !== draft.session
      if (ended && options.ended === "recover" && options.next !== true) {
        const recovered = content.trim() !== "" && content !== shown(draft)
        if (recovered) yield* recover(draft.user_id, toDraft(draft).key, [content], "discard")
        return { draft: toDraft(draft), recovered }
      }
      const changed =
        draft.status === "active" &&
        (base === null || ended || options.next === true || draft.text_version > base.rowVersion)
      // On another tab's text, the draft keeps the revision that text was started from.
      yield* update(draft, content, "edit", changed ? null : options.baseRevision, changed)
      return { draft: toDraft((yield* byId(draft.id))!), recovered: false }
    })

  /** Saves a draft by its key, creating it (after `checkTarget`) if there's none. */
  const save = (options: {
    readonly userId: UserId
    readonly key: DraftKey
    readonly content: string
    readonly base: Base | null
    readonly baseRevision: string | null
    readonly checkTarget: Effect.Effect<void, NotFound, never>
  }) =>
    Effect.gen(function* () {
      yield* tooLarge(options.content)
      const existing = yield* find(options.userId, options.key)
      if (existing !== null) {
        const saved = yield* saveOnto(existing, options.base, options.content, {
          baseRevision: options.baseRevision,
          ended: "reopen"
        })
        return saved.draft
      }
      yield* options.checkTarget
      yield* insert(options.userId, options.key, options.content, options.baseRevision)
      return toDraft((yield* find(options.userId, options.key))!)
    })

  const restoreRow = (draft: DraftRow, seq: number, expectedRowVersion: number) =>
    Effect.gen(function* () {
      yield* checkVersion(draft, expectedRowVersion)
      const content = yield* stateAt(draft, seq)
      yield* update(draft, content, "restore", null)
      return toDraft((yield* find(draft.user_id, toDraft(draft).key))!)
    })

  const restore = (userId: UserId, key: DraftKey, seq: number, expectedRowVersion: number) =>
    Effect.flatMap(get(userId, key), (draft) => restoreRow(draft, seq, expectedRowVersion))

  /**
   * Ends a drafting session. The committed text now lives in a version or revision, so
   * the history is deleted and the draft emptied (owner, 2026-10-10). Text that would be
   * lost goes to the bin's recovered-text section: the text from before each destructive
   * change in the session (hours of typing wiped, then saved), and a discarded draft.
   */
  const end = (draft: DraftRow, outcome: "committed" | "discarded") =>
    Effect.gen(function* () {
      const lost = beforeKept(draft.content, yield* entries(draft.id))
      if (outcome === "discarded") lost.unshift(draft.content)
      yield* recover(draft.user_id, toDraft(draft).key, lost, outcome === "discarded" ? "discard" : "commit")
      yield* sql`DELETE FROM draft_history WHERE draft_id = ${draft.id}`
      const updatedAt = Date.now()
      yield* sql`UPDATE drafts SET status = ${outcome}, content = '', row_version = row_version + 1,
                   text_version = row_version + 1, session = session + 1, updated_at = ${updatedAt}
                 WHERE id = ${draft.id}`
      return toDraft({
        ...draft,
        status: outcome,
        content: "",
        row_version: draft.row_version + 1,
        text_version: draft.row_version + 1,
        session: draft.session + 1,
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

  // --- The composer (DESIGN §6.2): a draft per branch tip, which moves with its tip.

  /**
   * The composer at `key`, made empty if there's none, so every text typed in a composer
   * has a draft to name. `from` is the composer a branch starts from: its text is copied
   * in, never over text already there.
   */
  const openComposer = (userId: UserId, key: DraftKey, from: DraftRow | null) =>
    Effect.gen(function* () {
      const here = yield* find(userId, key)
      const copied = shown(from)
      if (here === null) yield* insert(userId, key, copied, null)
      else if (copied !== "" && shown(here) === "") yield* update(here, copied, "edit", null)
      return toDraft((yield* find(userId, key))!)
    })

  /**
   * Text typed into the composer draft `base` names, saved onto that draft wherever it is
   * now (its tip may have moved on with a message appended there), by `saveOnto`'s rule.
   * A draft that's gone sends the text to the recovered texts.
   */
  const saveComposer = (
    userId: UserId,
    chatId: string,
    base: { readonly draftId: string; readonly rowVersion: number; readonly session: number; readonly next: boolean },
    content: string
  ) =>
    Effect.gen(function* () {
      yield* tooLarge(content)
      const draft = yield* findComposer(userId, chatId, base.draftId)
      if (draft === null) {
        const recovered = content.trim() !== ""
        if (recovered) yield* recover(userId, composerKey(chatId, null), [content], "discard")
        return { draft: null, recovered }
      }
      return yield* saveOnto(draft, base, content, { baseRevision: null, ended: "recover", next: base.next })
    })

  const restoreComposer = (userId: UserId, chatId: string, draftId: string, seq: number, expectedRowVersion: number) =>
    Effect.gen(function* () {
      const draft = yield* findComposer(userId, chatId, draftId)
      if (draft === null) return yield* new NotFound({ entity: "draft", id: draftId })
      return yield* restoreRow(draft, seq, expectedRowVersion)
    })

  return {
    find,
    findComposer,
    get,
    toDraft,
    listActive,
    history,
    stateAt,
    save,
    restore,
    end,
    clear,
    commit,
    openComposer,
    saveComposer,
    restoreComposer
  }
}
