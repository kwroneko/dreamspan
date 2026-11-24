import type { EditingOrigin } from "@dreamspan/shared/drafts.ts"
// Draft storage shared by the writer and the readers (DESIGN §6.2). See
// @dreamspan/shared/drafts.ts for the patch model.
import {
  beforeDeletion,
  deletionMap,
  reconcileDeletedFields,
  trackDeletions,
  type DeletionBase
} from "@dreamspan/shared/draftDeletions.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import {
  applyPatch,
  composerKey,
  deletedSince,
  diffPatch,
  Draft,
  DraftHistoryPolicy,
  DraftDisplacement,
  type DraftKey,
  DraftState,
  excerpt,
  invertPatch,
  isDestructive,
  isEmptyPatch,
  isFormContent,
  parseDraftTarget,
  type Patch,
  type ObservedDeletion
} from "@dreamspan/shared/drafts.ts"
import { getAt, isHeldField, parseField } from "@dreamspan/shared/editing.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import type { MessageImages, EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import { ComposerChoice } from "@dreamspan/shared/composerApi.ts"
import { EDIT_THINKING_FIELD } from "@dreamspan/shared/chatApi.ts"
import { editableThinking, type ReplySections } from "@dreamspan/shared/replySections.ts"
import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import { createHash } from "node:crypto"
import { DraftTooLarge, NotFound, StaleWrite } from "./ops.ts"
import { makeLibraryQueries } from "./library.ts"
import { attachmentJson } from "./rows.ts"

interface DraftRow {
  readonly id: string
  readonly user_id: UserId
  readonly target_kind: DraftKey["targetKind"]
  readonly target_id: string
  readonly field: string
  readonly content: string
  readonly images_json: string | null
  readonly status: Draft["status"]
  readonly base_revision: string | null
  readonly committed_revision: string | null
  readonly cleared_version: number
  readonly deletions_json: string
  readonly row_version: number
  readonly session: number
  readonly text_version: number
  readonly created_at: number
  readonly updated_at: number
  readonly history_length: number
  /** The composer's choices (migration 0036); null for other drafts. */
  readonly speaker_entity_id: string | null
  readonly reply_from_entity_id: string | null
  readonly guidance: number
  /** 1 while the composer's Next is No one. */
  readonly no_replies: number
  /** The reply a new version's guidance is written for (migration 0011_guidance_target). */
  readonly guidance_slot_id: string | null
}

/** The draft a write took its text from: by its id, in the session it was typed in, with exactly that text. */
export interface CommitDraft {
  readonly draftId: string
  readonly session: number
}

/** A draft as a client had it when it typed: the row version and session (null before a field had a draft). */
interface Base {
  readonly rowVersion: number
  readonly session: number | null
}

/**
 * A library field's draft keeps its edit history across revisions (owner, 2026-11-01), and a
 * message's or a summary's edit across its saves (owner, 2026-11-02): a save (or a generation's
 * checkpoint) ends its session but keeps its text and every state, so the edit history runs on
 * through them. Other drafts' histories end with their session.
 */
const KEEPS_HISTORY: ReadonlySet<DraftKey["targetKind"]> = new Set(["entity_field", "version_edit", "summary_edit"])
const keepsHistory = (row: { readonly target_kind: DraftKey["targetKind"] }) => KEEPS_HISTORY.has(row.target_kind)

/** Settings and the held structural changes are plain values: their JSON never goes to the bin. */
const toBin = (row: { readonly target_kind: DraftKey["targetKind"]; readonly field: string }) =>
  !(
    (row.target_kind === "entity_field" || row.target_kind === "remote_card") &&
    (row.field.startsWith("=") || isHeldField(row.field))
  )

/**
 * Recover text as typed. Recover a lorebook entry's primary and secondary keys one per line.
 */
const binTexts = (
  row: { readonly target_kind: DraftKey["targetKind"]; readonly field: string },
  states: ReadonlyArray<string>
): ReadonlyArray<string> => {
  if (toBin(row)) return states
  const field = parseField(row.field)
  if (field?.kind !== "value") return []
  const path = field.path[0] === "character_book" ? field.path.slice(1) : field.path
  const [entries, entry, key] = path
  if (
    path.length !== 3 ||
    entries !== "entries" ||
    typeof entry !== "string" ||
    !/^uid=-?\d+$/.test(entry) ||
    (key !== "keys" && key !== "secondary_keys")
  )
    return []
  return states.flatMap((state) => {
    try {
      const value: unknown = JSON.parse(state)
      return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
        ? [value.join("\n")]
        : []
    } catch {
      return []
    }
  })
}

/** A field's value in a document, as its draft holds it: text, or a value's JSON. */
export const fieldContent = (doc: unknown, field: string) => {
  const parsed = parseField(field)
  if (parsed === null) return null
  const value = getAt(doc as Record<string, unknown>, parsed.path)
  if (parsed.kind === "value") return JSON.stringify(value) ?? "undefined"
  return typeof value === "string" ? value : ""
}

interface EntryRow {
  readonly seq: number
  readonly images_before_json: string | null
  readonly images_after_json: string | null
  readonly kind: "edit" | "restore" | "revision"
  readonly first_at: number
  readonly at: number
  readonly start: number
  readonly removed: string
  readonly inserted: string
  /** Keep the prior state: a displaced tab, or a destructive field edit inside a form. */
  readonly displaced: 0 | 1
}

/** A form's short fields must not disappear inside a much larger JSON snapshot. */
const formChange = (before: string, after: string) => {
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
  let left: unknown
  let right: unknown
  try {
    left = JSON.parse(before)
    right = JSON.parse(after)
  } catch {
    return null
  }
  if (!object(left) || !object(right)) return null
  const stack: Array<{ left: unknown; right: unknown; path: ReadonlyArray<string> }> = [{ left, right, path: [] }]
  const paths: Array<string> = []
  let destructive = false
  let visited = 0
  while (stack.length) {
    const { left, right, path } = stack.pop()!
    // Arbitrary text may happen to be JSON. Bound the extra work; our forms have shallow fields.
    if (++visited > 10_000 || path.length > 64) return null
    if (left === right) continue
    if (object(left) && object(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        stack.push({ left: left[key], right: right[key], path: [...path, key] })
    } else {
      paths.push(JSON.stringify(path))
      if (
        typeof left === "string" &&
        isDestructive(diffPatch(left, typeof right === "string" ? right : ""), left.length)
      )
        destructive = true
    }
  }
  return { paths: paths.sort().join("\n"), destructive }
}

const imageJson = (images: MessageImages) =>
  JSON.stringify(
    images.map((image) => ({
      mediaId: image.mediaId,
      altText: image.altText ?? "",
      ...(image.kind ? { kind: image.kind } : {}),
      ...(image.name !== undefined ? { name: image.name } : {}),
      ...(image.path !== undefined ? { path: image.path } : {})
    }))
  )
const imageFields = (json: string | null) => (json === null ? {} : { images: JSON.parse(json) as MessageImages })

const toDraft = (
  row: DraftRow,
  recovered = 0,
  displaced: DraftDisplacement | null = null,
  refused?: DraftDisplacement
) =>
  new Draft({
    recovered,
    displaced,
    ...(refused === undefined ? {} : { refused }),
    id: row.id,
    key: { targetKind: row.target_kind, targetId: row.target_id, field: row.field },
    content: row.content,
    ...(row.target_kind === "composer" ? { guidance: row.guidance === 1 } : {}),
    ...imageFields(row.images_json),
    status: row.status,
    baseRevision: row.base_revision,
    rowVersion: row.row_version,
    clearedVersion: row.cleared_version,
    deletions: JSON.parse(row.deletions_json) as NonNullable<Draft["deletions"]>,
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
 * Of texts on their way to the recovered texts, those really lost, in order: none empty,
 * none inside a text that stays (`kept`: the text committed, say), and none inside another
 * of them (an earlier, shorter state of the same text).
 */
const stillLost = (texts: ReadonlyArray<string>, kept: ReadonlyArray<string>) => {
  const unique = [...new Set(texts)].filter((text) => text.trim() !== "")
  return unique.filter(
    (text, index) =>
      !kept.some((other) => other.includes(text)) && !unique.some((other, at) => at !== index && other.includes(text))
  )
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
  ) => Effect.Effect<void, SqlError.SqlError> = () => Effect.void,
  now: () => number = Date.now
) => {
  const lib = makeLibraryQueries(sql)
  const find = (userId: UserId, key: DraftKey) =>
    sql<DraftRow>`
      SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
      FROM drafts d
      WHERE d.user_id = ${userId} AND d.target_kind = ${key.targetKind} AND d.target_id = ${key.targetId}
        AND d.field = ${key.field}`.pipe(Effect.map(([row]) => row ?? null))

  /** A field's content in a revision, as its draft would hold it. */
  const revisionContent = (revisionId: string, field: string) =>
    sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions WHERE id = ${revisionId}`.pipe(
      Effect.map(([row]) => (row ? fieldContent(JSON.parse(row.doc_json), field) : null))
    )

  /**
   * The text an edit that keeps its history starts from, as its editor shows it before any
   * typing: a library field's revision (`baseRevision`, checked by the caller), a summary's
   * revision (`baseRevision`, one of that summary's own), or the version a message edit edits.
   * Null when there's none to go by.
   */
  const startText = (
    key: { readonly targetKind: DraftKey["targetKind"]; readonly targetId: string; readonly field: string },
    baseRevision: string | null
  ): Effect.Effect<string | null, SqlError.SqlError> => {
    switch (key.targetKind) {
      case "entity_field":
        return baseRevision === null ? Effect.succeed(null) : revisionContent(baseRevision, key.field)
      case "summary_edit":
        return baseRevision === null
          ? Effect.succeed(null)
          : sql<{ content: string }>`SELECT content FROM summary_revisions
              WHERE id = ${baseRevision} AND summary_id = ${key.targetId}`.pipe(
              Effect.map(([row]) => row?.content ?? null)
            )
      case "version_edit":
        // The edit's thinking field starts from the version's thinking ("" without one): its
        // reasoning, or its reply sections' text.
        return key.field === EDIT_THINKING_FIELD
          ? sql<{ reasoning: string | null; reply_sections: string | null }>`
              SELECT reasoning, reply_sections FROM version_records WHERE id = ${key.targetId}`.pipe(
              Effect.map(([row]) =>
                row
                  ? editableThinking({
                      reasoning: row.reasoning,
                      replySections: row.reply_sections ? (JSON.parse(row.reply_sections) as ReplySections) : null
                    })
                  : null
              )
            )
          : sql<{ content: string }>`SELECT content FROM version_records WHERE id = ${key.targetId}`.pipe(
              Effect.map(([row]) => row?.content ?? null)
            )
      default:
        return Effect.succeed(null)
    }
  }

  /** Inherited images must become a snapshot: the version can be amended after this edit. */
  const startImages = (key: {
    readonly targetKind: DraftKey["targetKind"]
    readonly targetId: string
    readonly field?: string
  }) =>
    key.targetKind === "version_edit" && key.field !== EDIT_THINKING_FIELD
      ? sql<{ attachment: string }>`
          SELECT ${sql.literal(attachmentJson("a"))} AS attachment FROM version_attachments a
          WHERE a.version_id = ${key.targetId} ORDER BY a.ordinal`.pipe(
          Effect.map((rows) => imageJson(rows.map((row) => JSON.parse(row.attachment) as MessageImages[number])))
        )
      : Effect.succeed(null)

  const byId = (id: string) =>
    sql<DraftRow>`
      SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
      FROM drafts d WHERE d.id = ${id}`.pipe(Effect.map(([row]) => row ?? null))

  /** A chat's composer draft by its id, whichever fork it's in. */
  const findComposer = (userId: UserId, chatId: string, draftId: string) =>
    sql<DraftRow>`
      SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
      FROM drafts d
      WHERE d.id = ${draftId} AND d.user_id = ${userId} AND d.target_kind = 'composer'
        AND d.target_id = ${chatId}`.pipe(Effect.map(([row]) => row ?? null))

  const checkIdentity = (userId: UserId, id: string | null) =>
    Effect.gen(function* () {
      if (id === null) return
      const row = yield* byId(id)
      if (row !== null && row.user_id !== userId) return yield* new NotFound({ entity: "draft", id })
    })

  const get = (userId: UserId, key: DraftKey) =>
    Effect.flatMap(find(userId, key), (row) =>
      row
        ? Effect.succeed(row)
        : Effect.fail(new NotFound({ entity: "draft", id: `${key.targetKind}:${key.targetId}` }))
    )

  const entries = (draftId: string) =>
    sql<EntryRow>`SELECT * FROM draft_history WHERE draft_id = ${draftId} ORDER BY seq DESC`

  /**
   * What deleting a draft with its target would lose, newest first: its text and every earlier
   * state its history can restore, each not blank and not inside another or inside `kept`. For
   * the writes that delete a draft without ending it (a pending chat's sweep, a greeting rebuilt,
   * an old new-chat page's draft): its undo history goes with it, so nothing it held is lost.
   */
  const unsaved = (draftId: string, content: string, kept: ReadonlyArray<string>) =>
    Effect.map(entries(draftId), (history) =>
      stillLost([content, ...walkBack(content, history, -Infinity).map((step) => step.textBefore!.join(""))], kept)
    )

  const listActive = (userId: UserId) =>
    sql<DraftRow>`
      SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
      FROM drafts d WHERE d.user_id = ${userId} AND d.status = 'active' AND (d.content <> '' OR d.images_json IS NOT NULL)
      ORDER BY d.updated_at DESC`.pipe(Effect.map((rows) => rows.map((row) => toDraft(row))))

  /**
   * A chat's open message editors (`ListMessageDrafts`): edits of its versions, versions being
   * written, queue edits and messages being inserted.
   */
  const listMessageDrafts = (userId: UserId, chatId: string) =>
    sql<DraftRow>`
      SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
      FROM drafts d WHERE d.user_id = ${userId} AND d.status = 'active' AND (d.content <> '' OR d.images_json IS NOT NULL OR d.target_kind = 'queue_edit'
        -- An edit's thinking emptied is its thinking removed, still to be saved.
        OR (d.target_kind = 'version_edit' AND d.field = ${EDIT_THINKING_FIELD})) AND (
        (d.target_kind = 'version_edit' AND d.target_id IN (SELECT v.id FROM versions v JOIN slots s ON s.id = v.slot_id
          WHERE s.chat_id = ${chatId} AND v.deleted_at IS NULL AND s.deleted_at IS NULL))
        OR (d.target_kind = 'scratchpad' AND d.target_id IN (SELECT s.id FROM slots s
          WHERE s.chat_id = ${chatId} AND s.deleted_at IS NULL))
        OR (d.target_kind = 'queue_edit' AND d.target_id = ${chatId})
        OR (d.target_kind = 'insert' AND d.target_id = ${chatId}))
      ORDER BY d.updated_at DESC`.pipe(Effect.map((rows) => rows.map((row) => toDraft(row))))

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
  const history = (draft: DraftRow, limit: number, before?: number) =>
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
      return (before === undefined ? states : states.filter((state) => state.seq < before)).slice(0, limit)
    })

  /**
   * Drops the oldest entries beyond the retention limits. The text from before a dropped
   * destructive change goes to the recovered-text section first, as a commit would send it.
   */
  const retain = (draft: DraftRow, content: string) =>
    Effect.gen(function* () {
      const sizes = yield* sql<{ seq: number; at: number; removed: number; inserted: number; displaced: 0 | 1 }>`
        SELECT seq, at, length(removed) AS removed, length(inserted) AS inserted, displaced
        FROM draft_history WHERE draft_id = ${draft.id} ORDER BY seq DESC`
      let total = 0
      // A library field keeps whichever is more: its last 200 states or its last 30 days.
      const keepFrom = now() - DraftHistoryPolicy.fieldDays * 86_400_000
      const cut = keepsHistory(draft)
        ? sizes.findIndex((row, index) => index >= DraftHistoryPolicy.fieldStates && row.at < keepFrom)
        : sizes.findIndex((row, index) => {
            total += row.removed + row.inserted
            return index >= DraftHistoryPolicy.maxEntries || (index > 0 && total > DraftHistoryPolicy.maxHistoryChars)
          })
      if (cut < 0) return 0
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
      let recovered = 0
      if (mayLoseText && toBin(draft)) {
        const lost = stillLost(
          beforeKept(content, yield* entries(draft.id), (seq) => seq <= cutSeq),
          [content]
        )
        yield* recover(draft.user_id, toDraft(draft).key, lost, "commit")
        recovered = lost.length
      }
      yield* sql`DELETE FROM draft_history WHERE draft_id = ${draft.id} AND seq <= ${cutSeq}`
      return recovered
    })

  /**
   * Records `patch` (turning the draft's text into `content`), extending the last entry when
   * typing continues. One saved over another tab's text (`displaced`) never extends one.
   */
  const record = (
    draft: DraftRow,
    content: string,
    patch: Patch,
    kind: "edit" | "restore" | "revision",
    now: number,
    displaced: boolean,
    imagesJson: string | null,
    trim = true
  ) =>
    Effect.gen(function* () {
      const form = draft.target_kind === "user_field" ? formChange(draft.content, content) : null
      const keep = displaced || form?.destructive === true
      const [last] =
        yield* sql<EntryRow>`SELECT * FROM draft_history WHERE draft_id = ${draft.id} ORDER BY seq DESC LIMIT 1`
      if (
        last &&
        !keep &&
        kind === "edit" &&
        last.kind === "edit" &&
        draft.status === "active" &&
        imagesJson === draft.images_json &&
        last.images_before_json === last.images_after_json
      ) {
        const lastPatch = patchOf(last)
        const beforeLast = applyPatch(draft.content, invertPatch(lastPatch))
        const sameField = form === null || formChange(beforeLast, draft.content)?.paths === form.paths
        const continuing =
          sameField &&
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
          return 0
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
        images_before_json: draft.images_json,
        images_after_json: imagesJson,
        displaced: keep ? 1 : 0
      })}`
      return trim ? yield* retain(draft, content) : 0
    })

  /** The draft the client named, as it saw it: another draft at its key, or a newer version, is stale. */
  const checkDraft = (draft: DraftRow, id: string, expected: number) =>
    draft.id === id && draft.row_version === expected
      ? Effect.void
      : Effect.fail(new StaleWrite({ entity: "draft", id: draft.id, expected, actual: draft.row_version }))

  /** Moves the draft to `content`, recording the change, and returns the saved draft. */
  const update = (
    draft: DraftRow,
    content: string,
    kind: "edit" | "restore" | "revision",
    baseRevision: string | null,
    displaced = false,
    imagesJson: string | null = draft.images_json,
    deliberate = true,
    formEdit?: { readonly before: EditingOrigin | null; readonly content: string }
  ) =>
    Effect.gen(function* () {
      const at = now()
      const patch = diffPatch(draft.content, content)
      // Saving the same text against a new base revision only moves the base.
      const sameBase = baseRevision === null || baseRevision === draft.base_revision
      const imagesChanged = imagesJson !== draft.images_json
      const deletions = trackDeletions(
        toDraft(draft),
        content,
        draft.target_kind === "user_field",
        deliberate,
        formEdit
      )
      const newDeletion = Object.values(deletions).some(
        (marker) => marker.draftId === draft.id && marker.rowVersion === draft.row_version + 1
      )
      if (isEmptyPatch(patch) && !imagesChanged && draft.status === "active" && sameBase && !newDeletion) return 0
      const recovered =
        isEmptyPatch(patch) && !imagesChanged
          ? 0
          : yield* record(draft, content, patch, kind, at, displaced, imagesJson)
      // A save after a commit or discard starts a new drafting session.
      const reopened = draft.status !== "active"
      const textChanged = reopened || !isEmptyPatch(patch) || imagesChanged
      const clears = deletions[""]?.draftId === draft.id && deletions[""]?.rowVersion === draft.row_version + 1
      yield* sql`UPDATE drafts SET content = ${content}, images_json = ${imagesJson}, status = 'active',
                   base_revision = ${baseRevision ?? draft.base_revision},
                   deletions_json = ${JSON.stringify(deletions)},
                   cleared_version = CASE WHEN ${clears ? 1 : 0} THEN row_version + 1 ELSE cleared_version END,
                   row_version = row_version + 1,
                   text_version = CASE WHEN ${textChanged ? 1 : 0} THEN row_version + 1 ELSE text_version END,
                   updated_at = ${at}
                 WHERE id = ${draft.id}`
      return recovered
    })

  const insert = (
    userId: UserId,
    key: DraftKey,
    content: string,
    baseRevision: string | null,
    imagesJson: string | null = null
  ) => {
    const at = now()
    return sql`INSERT INTO drafts ${sql.insert({
      id: uuidv7(),
      user_id: userId,
      target_kind: key.targetKind,
      target_id: key.targetId,
      field: key.field,
      content,
      images_json: imagesJson,
      base_revision: baseRevision,
      status: "active",
      created_at: at,
      updated_at: at
    })}`
  }

  const tooLarge = (content: string) =>
    content.length > DraftHistoryPolicy.maxContentChars
      ? Effect.fail(new DraftTooLarge({ length: content.length, max: DraftHistoryPolicy.maxContentChars }))
      : Effect.void

  const shown = (draft: DraftRow | null) => (draft?.status === "active" ? draft.content : "")

  const composerCommitHash = (content: string) => createHash("sha256").update(content, "utf16le").digest("hex")

  /** Only the commit that took this composer session can account for a late copy. */
  const composerCommitted = (draftId: string, session: number, content: string) =>
    sql<{ found: number }>`SELECT EXISTS (
        SELECT 1 FROM composer_commits WHERE draft_id = ${draftId} AND session = ${session}
          AND content_hash = ${composerCommitHash(content)}
      ) AS found`.pipe(Effect.map(([row]) => row?.found === 1))

  /**
   * The one rule for text saved onto a draft, every kind, in the writer's transaction.
   * `base` is the draft as the client had it when the text was typed (null: it had none).
   * - Typed on the draft as it is: saved, extending the history as typing does.
   * - A deletion advanced `cleared_version` past the base: recover the submitted text
   *   and leave the field alone. This wins over the following rules.
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
    options: {
      readonly baseRevision: string | null
      readonly ended: "recover" | "reopen"
      readonly observedDeletion?: ObservedDeletion | undefined
      readonly editingFrom?: EditingOrigin | undefined
      readonly deliberate?: boolean
      readonly deletionBase?: DeletionBase
      readonly next?: boolean
      readonly images?: MessageImages | undefined
    }
  ) =>
    Effect.gen(function* () {
      const ended = base !== null && base.session !== null && base.session !== draft.session
      // Deliberate deletion wins over writes typed before it, including keepalive and
      // Browser recovery retries. Sending a composer ends its session without deleting
      // its separately typed `next` text; manual deletion always wins.
      const deletionBase = options.deletionBase ?? {
        draftId: draft.id,
        expectedRowVersion: base?.rowVersion ?? null,
        ...(options.deliberate === false || options.editingFrom === undefined
          ? {}
          : { editingFrom: options.editingFrom }),
        ...(options.observedDeletion ? { observedDeletion: options.observedDeletion } : {})
      }
      const barrier = deletionMap(toDraft(draft))[""]
      const deleted = barrier !== undefined && beforeDeletion(draft.id, barrier, deletionBase)
      const original = content
      // What the edit's input clears are measured from: the text it says it was edited from,
      // or, typed on exactly this version, this version's text.
      const editedFrom =
        options.deliberate === false
          ? null
          : (options.editingFrom ??
            (deletionBase.draftId === draft.id && deletionBase.expectedRowVersion === draft.row_version
              ? draft.content
              : null))
      // A form typed on a version that isn't the current one (owner, 2026-11-24): refused, never
      // merged. The draft keeps its value; the refused version goes into its history one step
      // behind it (marked displaced, so it reaches the recovered texts if the session ends
      // without it), and the answer names it, so its tab can show the current one and offer it back.
      if (
        !deleted &&
        draft.target_kind === "user_field" &&
        draft.status === "active" &&
        (base === null || ended || draft.text_version > base.rowVersion) &&
        content !== draft.content &&
        isFormContent(content) &&
        isFormContent(draft.content)
      ) {
        const at = now()
        let recovered = 0
        // A form's starting snapshot (`seed`) was never typed: nothing to keep.
        if (options.deliberate !== false) {
          // The refused snapshot is only an intermediate history state. Trim against
          // the actual current snapshot after both entries are in place.
          yield* record(draft, content, diffPatch(draft.content, content), "edit", at, true, draft.images_json, false)
          recovered = yield* record(
            { ...draft, content },
            draft.content,
            diffPatch(content, draft.content),
            "restore",
            at,
            true,
            draft.images_json
          )
        }
        const refused = new DraftDisplacement({ at, content })
        return {
          draft: toDraft((yield* byId(draft.id))!, recovered, null, refused),
          recovered: recovered > 0,
          accepted: false
        }
      }
      const reconciled = reconcileDeletedFields(
        toDraft(draft),
        options.deliberate === false ? null : deletionBase,
        content
      )
      if (deleted || reconciled.rejected || (ended && options.ended === "recover" && options.next !== true)) {
        // A different session's text cannot account for an old composer copy.
        const kept =
          ended && draft.target_kind === "composer" && content.trim() !== ""
            ? yield* composerCommitted(draft.id, base.session, content)
            : draft.target_kind === "user_field"
              ? content === shown(draft)
              : shown(draft).includes(content)
        const recovered = toBin(draft) && content.trim() !== "" && !kept
        if (recovered) yield* recover(draft.user_id, toDraft(draft).key, [content], "discard")
        return { draft: toDraft(draft, recovered ? 1 : 0), recovered, accepted: false }
      }
      let recoveredInput = false
      if (reconciled.changed) {
        if (toBin(draft) && content.trim() !== "") {
          yield* recover(draft.user_id, toDraft(draft).key, [content], "discard")
          recoveredInput = true
        }
        content = reconciled.content
      }
      // A library field's session a save or a checkpoint ended keeps its text: typing on
      // exactly that text (the tab saw it last) goes on from the revision that holds it.
      const onCommitted =
        keepsHistory(draft) &&
        draft.status === "committed" &&
        ended &&
        base !== null &&
        base.rowVersion >= draft.text_version
      const changed =
        draft.status === "active" &&
        (base === null || ended || options.next === true || draft.text_version > base.rowVersion)
      const [last] = changed
        ? yield* sql<EntryRow>`SELECT * FROM draft_history WHERE draft_id = ${draft.id} ORDER BY seq DESC LIMIT 1`
        : []
      const imagesJson =
        options.images === undefined
          ? draft.status === "active"
            ? draft.images_json
            : yield* startImages(toDraft(draft).key)
          : imageJson(options.images)
      const displaced =
        changed && (draft.content !== content || draft.images_json !== imagesJson)
          ? new DraftDisplacement({
              at: last?.at ?? draft.created_at,
              content: draft.content,
              ...imageFields(draft.images_json)
            })
          : null
      // On another tab's text, the draft keeps the revision that text was started from.
      const recovered = yield* update(
        draft,
        content,
        "edit",
        onCommitted
          ? (draft.committed_revision ?? draft.base_revision)
          : ended
            ? (options.baseRevision ?? draft.base_revision)
            : changed
              ? null
              : options.baseRevision,
        changed,
        imagesJson,
        options.deliberate ?? true,
        draft.target_kind === "user_field" ? { before: editedFrom, content: original } : undefined
      )
      return {
        draft: toDraft((yield* byId(draft.id))!, recovered + Number(recoveredInput), displaced),
        recovered: recovered > 0 || recoveredInput,
        accepted: true
      }
    })

  /**
   * Saves a draft by its key, creating it (after `checkTarget`) if there's none. `draftId`
   * is the draft the text was typed into: if another draft is at the key now (that one
   * moved to a variant, and a new one started here), its text is kept and this goes on top.
   */
  const save = (options: {
    readonly userId: UserId
    readonly key: DraftKey
    readonly draftId: string | null
    readonly content: string
    readonly images?: MessageImages | undefined
    readonly base: Base | null
    readonly baseRevision: string | null
    readonly editingFrom?: EditingOrigin | undefined
    readonly seed?: boolean | undefined
    readonly checkTarget: Effect.Effect<void, NotFound, never>
    readonly observedDeletion?: ObservedDeletion | undefined
  }) =>
    Effect.gen(function* () {
      yield* tooLarge(options.content)
      yield* checkIdentity(options.userId, options.draftId)
      if (options.baseRevision !== null && options.key.targetKind === "entity_field") {
        const [target] = yield* sql<{
          entity_id: string
        }>`SELECT e.id AS entity_id FROM entity_refs f JOIN entities e ON e.id = f.entity_id
           WHERE f.id = ${parseDraftTarget(options.key.targetId).refId} AND e.owner_user_id = ${options.userId}`
        const revision = target ? yield* lib.draftBase(target.entity_id, options.baseRevision) : null
        if (!revision) return yield* new NotFound({ entity: "revision", id: options.baseRevision })
      }
      const keeps = keepsHistory({ target_kind: options.key.targetKind })
      let existing = yield* find(options.userId, options.key)
      // A resting edit that keeps its history, typed on text it doesn't hold (a revision
      // restored or merged in since, a message amended or a summary's revision picked
      // elsewhere): its history first goes to what the box showed, so that's a state too.
      // A library field's tab always names the session; a message's or a summary's reopened
      // editor may not have read the draft yet (null).
      if (
        keeps &&
        existing !== null &&
        existing.status !== "active" &&
        existing.cleared_version <= (options.base?.rowVersion ?? 0) &&
        (options.draftId === null || options.draftId === existing.id) &&
        (options.key.targetKind === "entity_field"
          ? options.base?.session === existing.session
          : options.base === null || options.base.session === existing.session)
      ) {
        const shownText = yield* startText(options.key, options.baseRevision)
        const shownImages = yield* startImages(options.key)
        if (shownText !== null && (shownText !== existing.content || existing.images_json !== shownImages)) {
          yield* record(
            existing,
            shownText,
            diffPatch(existing.content, shownText),
            "revision",
            now(),
            false,
            shownImages
          )
          yield* sql`UPDATE drafts SET content = ${shownText}, images_json = ${shownImages} WHERE id = ${existing.id}`
          existing = (yield* byId(existing.id))!
        }
      }
      if (existing !== null) {
        const typedHere = options.draftId === null || options.draftId === existing.id
        const currentId = existing.id
        // Older key-addressed callers supplied only a counter. That counter belongs to
        // this row only while its barriers have this same identity; a retained source
        // marker must never turn an unidentified old counter into a replacement-row base.
        const legacyBaseHere =
          options.base !== null &&
          Object.values(deletionMap(toDraft(existing))).every((marker) => marker.draftId === currentId)
        const saved = yield* saveOnto(existing, typedHere ? options.base : null, options.content, {
          baseRevision: options.baseRevision,
          ended: "reopen",
          deliberate: options.key.targetKind !== "user_field" || options.seed !== true,
          editingFrom: options.editingFrom,
          observedDeletion: options.observedDeletion,
          deletionBase: {
            draftId: options.draftId ?? (legacyBaseHere ? existing.id : null),
            expectedRowVersion: options.base?.rowVersion ?? null,
            ...(options.seed === true || options.editingFrom === undefined ? {} : { editingFrom: options.editingFrom }),
            ...(options.observedDeletion ? { observedDeletion: options.observedDeletion } : {})
          },
          images: options.images
        })
        return saved.draft
      }
      yield* options.checkTarget
      // An edit that keeps its history starts with the text it was typed on as its first
      // state: a library field's revision, a summary's revision, a message's version.
      const firstState = keeps ? yield* startText(options.key, options.baseRevision) : null
      const firstImages = yield* startImages(options.key)
      if (firstState !== null && (firstState !== options.content || options.images !== undefined)) {
        yield* insert(options.userId, options.key, firstState, options.baseRevision, firstImages)
        const seeded = (yield* find(options.userId, options.key))!
        yield* update(
          seeded,
          options.content,
          "edit",
          options.baseRevision,
          false,
          options.images === undefined ? firstImages : imageJson(options.images)
        )
        return toDraft((yield* find(options.userId, options.key))!)
      }
      yield* insert(
        options.userId,
        options.key,
        options.content,
        options.baseRevision,
        options.images === undefined ? firstImages : imageJson(options.images)
      )
      if (options.key.targetKind === "user_field" && options.seed !== true && options.editingFrom !== undefined) {
        const created = (yield* find(options.userId, options.key))!
        // A page can close before even its initial seed save. Its final copy still
        // carries actual clears, recorded at this row's first version atomically.
        const deletions = trackDeletions(
          { ...toDraft(created), content: "", rowVersion: created.row_version - 1 },
          options.content,
          true,
          true,
          { before: options.editingFrom, content: options.content }
        )
        if (Object.keys(deletions).length > 0)
          yield* sql`UPDATE drafts SET deletions_json = ${JSON.stringify(deletions)},
                     cleared_version = ${deletions[""]?.rowVersion ?? 0} WHERE id = ${created.id}`
      }
      return toDraft((yield* find(options.userId, options.key))!)
    })

  const restoreRow = (
    draft: DraftRow,
    seq: number,
    expectedRowVersion: number,
    draftId: string = draft.id,
    picked?: string,
    pickedImages?: MessageImages
  ) =>
    Effect.gen(function* () {
      yield* checkDraft(draft, draftId, expectedRowVersion)
      const content = picked ?? (yield* stateAt(draft, seq))
      // A history position restores the complete editor state; an explicitly picked
      // conflict text carries its matching images, or keeps the source's set.
      const undone = (yield* entries(draft.id)).filter((entry) => entry.seq > seq).at(-1)
      const imagesJson =
        picked !== undefined
          ? pickedImages === undefined
            ? null
            : imageJson(pickedImages)
          : undone
            ? undone.images_before_json
            : draft.images_json
      // A resting summary edit put back from its history is typed on the revision its last save wrote.
      const onRevision =
        draft.target_kind === "summary_edit" && draft.status !== "active" ? draft.committed_revision : null
      const recovered = yield* update(draft, content, "restore", onRevision, false, imagesJson)
      return toDraft((yield* find(draft.user_id, toDraft(draft).key))!, recovered)
    })

  const restore = (
    userId: UserId,
    key: DraftKey,
    draftId: string,
    seq: number,
    expectedRowVersion: number,
    content?: string,
    images?: MessageImages
  ) =>
    Effect.gen(function* () {
      yield* checkIdentity(userId, draftId)
      return yield* restoreRow(yield* get(userId, key), seq, expectedRowVersion, draftId, content, images)
    })

  /**
   * Ends a drafting session. The committed text now lives in a version or revision, so
   * the history is deleted and the draft emptied (owner, 2026-10-10). Text that would be
   * lost goes to the bin's recovered-text section: the text from before each destructive
   * change in the session (hours of typing wiped, then saved), and a discarded draft.
   * `recovered` counts those texts. Edits that keep their history (`keepsHistory`) keep it.
   */
  const end = (draft: DraftRow, outcome: "committed" | "discarded", revision: string | null = null) =>
    Effect.gen(function* () {
      // A library field's save or checkpoint, or a message's or summary's Save, keeps its
      // text and its whole history (owner, 2026-11-01 and 2026-11-02): the session ends, the
      // text it was typed on is now `revision`'s (or the version's), and typing on resumes
      // from there. Nothing goes to the bin: every state stays reachable.
      if (outcome === "committed" && keepsHistory(draft)) {
        const updatedAt = now()
        yield* sql`UPDATE drafts SET status = 'committed', row_version = row_version + 1, session = session + 1,
                     committed_revision = ${revision}, updated_at = ${updatedAt}
                   WHERE id = ${draft.id}`
        return { draft: toDraft((yield* byId(draft.id))!), recovered: 0 }
      }
      // A message's or summary's Cancel goes back to the text the edit started from, as a
      // state of its history, so the text cancelled is one step back and nothing goes to the
      // bin; the session ends there (owner, 2026-11-02).
      if (outcome === "discarded" && keepsHistory(draft) && draft.target_kind !== "entity_field") {
        const back = yield* startText(toDraft(draft).key, draft.base_revision)
        let recovered = 0
        const backImages = yield* startImages(toDraft(draft).key)
        const moves = back !== null && (back !== draft.content || draft.images_json !== backImages)
        if (moves)
          recovered = yield* record(draft, back, diffPatch(draft.content, back), "revision", now(), false, backImages)
        const updatedAt = now()
        yield* sql`UPDATE drafts SET deletions_json = ${JSON.stringify({ ...deletionMap(toDraft(draft)), "": { draftId: draft.id, rowVersion: draft.row_version + 1 } })}, cleared_version = row_version + 1, status = 'discarded', content = ${moves ? back : draft.content},
                     images_json = ${moves ? backImages : draft.images_json}, row_version = row_version + 1,
                     text_version = CASE WHEN ${moves ? 1 : 0} THEN row_version + 1 ELSE text_version END,
                     session = session + 1, updated_at = ${updatedAt}
                   WHERE id = ${draft.id}`
        return { draft: toDraft((yield* byId(draft.id))!, recovered), recovered }
      }
      // A library field's history starts at its revision's text, which that revision keeps.
      const based =
        draft.target_kind === "entity_field" && draft.base_revision !== null
          ? yield* revisionContent(draft.base_revision, draft.field)
          : null
      // Text the commit keeps (or the revision it was typed on holds) isn't lost.
      const earlier = beforeKept(draft.content, yield* entries(draft.id))
      const lost = binTexts(
        draft,
        stillLost(outcome === "discarded" ? [draft.content, ...earlier] : earlier, [
          ...(outcome === "committed" ? [draft.content] : []),
          ...(based === null ? [] : [based])
        ])
      )
      if (lost.length > 0)
        yield* recover(draft.user_id, toDraft(draft).key, lost, outcome === "discarded" ? "discard" : "commit")
      yield* sql`DELETE FROM draft_history WHERE draft_id = ${draft.id}`
      const updatedAt = now()
      const clears = outcome === "discarded"
      const deletionsJson = JSON.stringify(
        clears
          ? { ...deletionMap(toDraft(draft)), "": { draftId: draft.id, rowVersion: draft.row_version + 1 } }
          : deletionMap(toDraft(draft))
      )
      yield* sql`UPDATE drafts SET deletions_json = ${deletionsJson}, cleared_version = CASE WHEN ${clears ? 1 : 0} THEN row_version + 1 ELSE cleared_version END, status = ${outcome}, content = '', images_json = NULL, row_version = row_version + 1,
                   text_version = row_version + 1, session = session + 1, updated_at = ${updatedAt}
                 WHERE id = ${draft.id}`
      const ended = toDraft(
        {
          ...draft,
          deletions_json: deletionsJson,
          cleared_version: clears ? draft.row_version + 1 : draft.cleared_version,
          status: outcome,
          content: "",
          images_json: null,
          row_version: draft.row_version + 1,
          text_version: draft.row_version + 1,
          session: draft.session + 1,
          updated_at: updatedAt,
          history_length: 0
        },
        lost.length
      )
      return { draft: ended, recovered: lost.length }
    })

  const clear = (
    userId: UserId,
    key: DraftKey,
    draftId: string,
    outcome: "committed" | "discarded",
    expectedRowVersion: number
  ) =>
    Effect.gen(function* () {
      yield* checkIdentity(userId, draftId)
      const draft = yield* get(userId, key)
      yield* checkDraft(draft, draftId, expectedRowVersion)
      return (yield* end(draft, outcome)).draft
    })

  /**
   * For writes that commit a draft: the draft the client took the text from, by its id, in
   * the session it was typed in, holding exactly that text. Only then is it committed;
   * otherwise it's left as it is (another tab typed on, or it was sent already), so a
   * commit never ends text it didn't take. Returns the draft as the write left it.
   */
  const commit = (
    userId: UserId,
    commitDraft: CommitDraft | null,
    destination: {
      /** The kind of draft it may be; several when more than one editor can send here. */
      readonly targetKind: DraftKey["targetKind"] | ReadonlyArray<DraftKey["targetKind"]>
      readonly targetId: string
      /** Match the editor within the target, before it can be ended or returned to the caller. */
      readonly matchesField?: (kind: DraftKey["targetKind"], field: string) => boolean
      readonly content: string | ((field: string) => string | null)
      readonly images?: MessageImages | undefined
      /** The revision the commit wrote (a summary's), which a resting edit put back from its history is typed on. */
      readonly revision?: string | undefined
      /**
       * Where the edit's text now lives, when that's another target than the one it was typed
       * for: a message's edit saved as a new version (or a branch's copy) moves there with its
       * history, so editing the message again goes on with it.
       */
      readonly moveTo?: string | undefined
    }
  ) =>
    Effect.gen(function* () {
      if (commitDraft === null) return { draft: null, recovered: 0 }
      yield* checkIdentity(userId, commitDraft.draftId)
      const draft = yield* byId(commitDraft.draftId)
      if (draft === null || draft.user_id !== userId) return { draft: null, recovered: 0 }
      const kinds: ReadonlyArray<string> =
        typeof destination.targetKind === "string" ? [destination.targetKind] : destination.targetKind
      if (
        !kinds.includes(draft.target_kind) ||
        draft.target_id !== destination.targetId ||
        (destination.matchesField !== undefined && !destination.matchesField(draft.target_kind, draft.field))
      )
        return { draft: null, recovered: 0 }
      const content = typeof destination.content === "string" ? destination.content : destination.content(draft.field)
      if (
        draft.status === "active" &&
        draft.session === commitDraft.session &&
        draft.content === content &&
        (draft.images_json === null ||
          (destination.images !== undefined && draft.images_json === imageJson(destination.images)))
      ) {
        if (draft.target_kind === "composer" && draft.content.trim() !== "") {
          yield* sql`INSERT INTO composer_commits ${sql.insert({
            draft_id: draft.id,
            session: draft.session,
            content_hash: composerCommitHash(draft.content)
          })}`
        }
        const ended = yield* end(draft, "committed", destination.revision ?? null)
        if (destination.moveTo === undefined || !keepsHistory(draft)) return ended
        yield* moveTo(draft.id, draft.target_id, destination.moveTo)
        return { ...ended, draft: toDraft((yield* byId(draft.id))!) }
      }
      return { draft: toDraft(draft), recovered: 0 }
    })

  /**
   * A resting edit of `from` moved to another target of its kind with its history (a
   * message's edit to the version its Save made), unless that target has a draft of its own
   * already. An edit typed on since stays where it was typed.
   */
  const moveTo = (draftId: string, from: string, targetId: string, active = false) =>
    Effect.gen(function* () {
      const source = yield* byId(draftId)
      if (source === null || source.target_id !== from || (source.status === "active" && !active)) return
      const key = toDraft(source).key
      if ((yield* find(source.user_id, { ...key, targetId })) !== null) return
      yield* sql`UPDATE drafts SET target_id = ${targetId}, row_version = row_version + ${active ? 1 : 0}, updated_at = ${active ? now() : source.updated_at} WHERE id = ${draftId}`
      // History follows the saved version. The original logical input retains its barrier,
      // including its origin/version, so late copies cannot manufacture a new active row.
      if (Object.keys(deletionMap(toDraft(source))).length === 0) return
      const content = (yield* startText(key, source.base_revision)) ?? ""
      const images = yield* startImages(key)
      const at = now()
      yield* sql`INSERT INTO drafts ${sql.insert({
        id: uuidv7(),
        user_id: source.user_id,
        target_kind: key.targetKind,
        target_id: from,
        field: key.field,
        content,
        images_json: images,
        base_revision: source.base_revision,
        status: "committed",
        deletions_json: JSON.stringify(deletionMap(toDraft(source))),
        created_at: at,
        updated_at: at
      })}`
    })

  /** Active library edits follow a new variant, with the same source-barrier rule. */
  const moveFields = (userId: UserId, from: string, targetId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string }>`SELECT id FROM drafts WHERE user_id = ${userId}
        AND target_kind = 'entity_field' AND target_id = ${from} AND status = 'active'`
      for (const row of rows) yield* moveTo(row.id, from, targetId, true)
    })

  /** A draft by its id, the user's own only. */
  const ownDraft = (userId: UserId, id: string) =>
    Effect.map(byId(id), (row) => (row !== null && row.user_id === userId ? toDraft(row) : null))

  // --- The composer (DESIGN §6.2): a draft per fork.

  /**
   * The composer at `key`, made empty if there's none, so every text typed in a composer
   * has a draft to name. `from` is the composer a branch starts from: its text is copied
   * in, never over text already there.
   */
  const openComposer = (userId: UserId, key: DraftKey, from: DraftRow | null) =>
    Effect.gen(function* () {
      const here = yield* find(userId, key)
      const copied = shown(from)
      let recovered = 0
      if (here === null) yield* insert(userId, key, copied, null)
      else if (copied !== "" && shown(here) === "") recovered = yield* update(here, copied, "edit", null)
      const opened = (yield* find(userId, key))!
      // Only a new branch inherits choices. Reopening an existing fork must keep even an
      // explicit reset to turn order (null), as switching branches keeps their text.
      if (from !== null && here === null)
        yield* sql`UPDATE drafts SET speaker_entity_id = ${from.speaker_entity_id},
          reply_from_entity_id = ${from.reply_from_entity_id}, guidance = ${from.guidance},
          no_replies = ${from.no_replies} WHERE id = ${opened.id}`
      return toDraft(from !== null && here === null ? { ...opened, guidance: from.guidance } : opened, recovered)
    })

  const choiceOf = (row: DraftRow) =>
    new ComposerChoice({
      draftId: row.id,
      guidance: row.guidance === 1,
      speakerEntityId: row.speaker_entity_id as EntityId | null,
      replyFromEntityId: row.reply_from_entity_id as EntityId | null,
      noReplies: row.no_replies === 1,
      guidanceSlotId: row.guidance_slot_id as SlotId | null
    })

  /** The speaker and reply choice of a composer draft of the user's chat. */
  const composerChoice = (userId: UserId, chatId: string, draftId: string) =>
    Effect.gen(function* () {
      const draft = yield* findComposer(userId, chatId, draftId)
      if (draft === null) return yield* new NotFound({ entity: "draft", id: draftId })
      return choiceOf(draft)
    })

  /**
   * Sets what's given of a composer draft's choices. A choice isn't text: the last one made
   * wins, and the draft's row version, which its text saves name, doesn't change.
   */
  const setComposerChoice = (
    userId: UserId,
    chatId: string,
    draftId: string,
    change: {
      readonly speakerEntityId?: EntityId | null
      readonly replyFromEntityId?: EntityId | null
      readonly guidance?: boolean
      readonly noReplies?: boolean
      readonly guidanceSlotId?: SlotId | null
      readonly consumeReplyFromEntityId?: EntityId
    }
  ) =>
    Effect.gen(function* () {
      const draft = yield* findComposer(userId, chatId, draftId)
      if (draft === null) return yield* new NotFound({ entity: "draft", id: draftId })
      for (const id of [change.speakerEntityId, change.replyFromEntityId, change.consumeReplyFromEntityId]) {
        if (id === undefined || id === null) continue
        const [card] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM entities
          WHERE id = ${id} AND owner_user_id = ${userId} AND kind = 'card' AND deleted_at IS NULL`
        if (card!.n === 0) return yield* new NotFound({ entity: "entity", id })
      }
      const speaker = change.speakerEntityId === undefined ? draft.speaker_entity_id : change.speakerEntityId
      const replyFrom =
        change.consumeReplyFromEntityId !== undefined
          ? draft.reply_from_entity_id === change.consumeReplyFromEntityId
            ? null
            : draft.reply_from_entity_id
          : change.replyFromEntityId === undefined
            ? draft.reply_from_entity_id
            : change.replyFromEntityId
      if (change.guidanceSlotId !== undefined && change.guidanceSlotId !== null) {
        const [slot] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM slots
          WHERE id = ${change.guidanceSlotId} AND chat_id = ${chatId} AND deleted_at IS NULL`
        if (slot!.n === 0) return yield* new NotFound({ entity: "slot", id: change.guidanceSlotId })
      }
      const guidance = change.guidance === undefined ? draft.guidance : Number(change.guidance)
      const noReplies = change.noReplies === undefined ? draft.no_replies : Number(change.noReplies)
      const guidanceSlot = change.guidanceSlotId === undefined ? draft.guidance_slot_id : change.guidanceSlotId
      yield* sql`UPDATE drafts SET speaker_entity_id = ${speaker}, reply_from_entity_id = ${replyFrom}, guidance = ${guidance},
        no_replies = ${noReplies}, guidance_slot_id = ${guidanceSlot} WHERE id = ${draft.id}`
      return choiceOf({
        ...draft,
        speaker_entity_id: speaker,
        reply_from_entity_id: replyFrom,
        guidance,
        no_replies: noReplies,
        guidance_slot_id: guidanceSlot
      })
    })

  /**
   * Text typed into the composer draft `base` names, saved onto that draft wherever it is
   * now, by `saveOnto`'s rule.
   * A draft that's gone sends the text to the recovered texts.
   */
  const saveComposer = (
    userId: UserId,
    chatId: string,
    base: {
      readonly draftId: string
      readonly rowVersion: number
      readonly session: number
      readonly next: boolean
      readonly operationId: string
    },
    content: string
  ) =>
    Effect.gen(function* () {
      yield* tooLarge(content)
      yield* checkIdentity(userId, base.draftId)
      const named = yield* byId(base.draftId)
      if (named !== null && (named.target_kind !== "composer" || named.target_id !== chatId))
        return yield* new NotFound({ entity: "draft", id: base.draftId })
      const draft = yield* findComposer(userId, chatId, base.draftId)
      {
        const [receipt] = yield* sql<{
          recovered: number
          displaced_json: string | null
          accepted_session: number | null
        }>`SELECT recovered, displaced_json, accepted_session FROM composer_save_receipts
          WHERE chat_id = ${chatId} AND operation_id = ${base.operationId}`
        if (receipt !== undefined) {
          let displaced: DraftDisplacement | null = null
          if (
            draft !== null &&
            receipt.displaced_json !== null &&
            !deletedSince(toDraft(draft), { draftId: base.draftId, expectedRowVersion: base.rowVersion })
          ) {
            const kept = JSON.parse(receipt.displaced_json) as { session: number; seq: number; at: number }
            const [entry] = yield* sql<EntryRow>`SELECT * FROM draft_history
              WHERE draft_id = ${draft.id} AND seq = ${kept.seq + 1} AND displaced = 1`
            if (draft.session === kept.session && entry !== undefined)
              displaced = new DraftDisplacement({ at: kept.at, content: yield* stateAt(draft, kept.seq) })
          }
          return {
            draft: draft === null ? null : toDraft(draft, receipt.recovered, displaced),
            recovered: receipt.recovered === 1,
            accepted: draft !== null && receipt.accepted_session === draft.session
          }
        }
      }
      let saved
      if (draft === null) {
        const recovered = content.trim() !== ""
        if (recovered) yield* recover(userId, composerKey(chatId, null), [content], "discard")
        saved = { draft: null, recovered, accepted: false }
      } else {
        const next = base.next && draft.session <= base.session + 1
        saved = yield* saveOnto(draft, base, content, { baseRevision: null, ended: "recover", next })
      }
      {
        const displaced = saved.draft?.displaced
        const [entry] =
          displaced == null
            ? []
            : yield* sql<EntryRow>`SELECT * FROM draft_history WHERE draft_id = ${base.draftId} ORDER BY seq DESC LIMIT 1`
        yield* sql`INSERT INTO composer_save_receipts ${sql.insert({
          chat_id: chatId,
          operation_id: base.operationId,
          recovered: saved.recovered ? 1 : 0,
          accepted_session: saved.accepted ? saved.draft!.session : null,
          displaced_json:
            displaced == null || entry === undefined
              ? null
              : JSON.stringify({ session: saved.draft!.session, seq: entry.seq - 1, at: displaced.at })
        })}`
      }
      return saved
    })

  const restoreComposer = (
    userId: UserId,
    chatId: string,
    draftId: string,
    seq: number,
    expectedRowVersion: number,
    content?: string
  ) =>
    Effect.gen(function* () {
      const draft = yield* findComposer(userId, chatId, draftId)
      if (draft === null) return yield* new NotFound({ entity: "draft", id: draftId })
      return yield* restoreRow(draft, seq, expectedRowVersion, draftId, content)
    })

  /**
   * A library field's draft moved to `content` (a restored revision's text, appended as a
   * restore, so the live text before it stays a state) and its session ended on `revision`.
   */
  const settleOn = (draft: DraftRow, content: string, revision: string, deliberate = true) =>
    Effect.gen(function* () {
      yield* update(draft, content, "revision", revision, false, draft.images_json, deliberate)
      return yield* end((yield* byId(draft.id))!, "committed", revision)
    })

  return {
    settleOn,
    find,
    checkIdentity,
    findComposer,
    get,
    toDraft,
    listActive,
    listMessageDrafts,
    history,
    stateAt,
    save,
    restore,
    end,
    unsaved,
    clear,
    commit,
    moveTo,
    moveFields,
    ownDraft,
    openComposer,
    composerChoice,
    setComposerChoice,
    saveComposer,
    restoreComposer
  }
}
