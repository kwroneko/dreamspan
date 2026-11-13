// Search and replace across the library, the reads (ARCHITECTURE §14.6 "Across the library";
// @rp/shared/libraryReplace.ts). Every live, unarchived card, lorebook, preset and note of the
// user's of the kinds asked for is searched as its editor shows it: its head with its unsaved
// changes (active drafts) on it, through the fields the editors search (libraryText.ts), with the
// matcher the chat's Search and replace uses (historyScan.ts, in a VM with a deadline). A chat's
// own note (its text is per branch) and a note an agent reply wrote are left out, as the
// library's list leaves the latter out. An entry with unsaved changes is listed but never
// replaced in: it is skipped, with why (owner, 2026-11-13). The preview gives each entry a stamp
// (its head, row version and drafts); the plan for a replace reads the chosen entries again,
// refuses one whose stamp moved, and works out the documents the writer stores
// (libraryReplaceWrites.ts), so the writer's transaction does no matching.
import type { UserId } from "@rp/shared/domain.ts"
import { canonicalJson, applyDrafts, type FieldPath, isHeldField, textField, withValues } from "@rp/shared/editing.ts"
import type { Doc } from "@rp/shared/library.ts"
import {
  AROUND,
  LIBRARY_UNSAVED_REASON,
  type FieldExcerpt,
  type LibraryChoice,
  type LibraryEdit,
  type LibraryEntryHit,
  type LibraryPreview,
  LibraryReplaceRejected,
  type LibraryReplaceKind,
  type LibrarySearch,
  type LibrarySkipped
} from "@rp/shared/libraryReplace.ts"
import { libraryReplaceKinds, libraryTextFields, type Searchable } from "@rp/shared/libraryText.ts"
import { editedDoc } from "@rp/shared/presetConditions.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { scanHistory } from "./historyScan.ts"
import type { LibraryReplaceEntry } from "./ops.ts"
import { query } from "./tx.ts"

/** Documents read per statement. */
const BATCH = 100
/** Text one scan goes through at most (characters), and how long it may take. */
const SCAN_CHARS = 2_000_000
const SCAN_TIMEOUT = 2000

interface Candidate {
  readonly entity_id: string
  readonly ref_id: string
  readonly kind: LibraryReplaceKind
  readonly label: string
  readonly subtitle: string
  readonly head: string
  readonly row_version: number
  readonly drafted: number
}

interface DraftRow {
  readonly id: string
  readonly field: string
  readonly content: string
  readonly row_version: number
}

/** An entry as its editor shows it. */
interface Working {
  readonly candidate: Candidate
  /** The head, with its unsaved changes on it where they apply, so the search finds what the editor shows. */
  readonly doc: Doc
  /** Why a replace skips it; null when it can be replaced in. */
  readonly blocked: string | null
  readonly stamp: string
}

interface Match {
  readonly start: number
  readonly end: number
  readonly replacement: string
}

interface Scanned {
  readonly field: Searchable
  readonly matches: ReadonlyArray<Match>
  readonly after: string
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)
const ascii = /^[\x00-\x7f]*$/

/**
 * The SQL that keeps only entries whose saved text could match, for a plain search: the search
 * text holds every string of the head. Entries with drafts and presets (whose editor adds
 * prompts the head stores elsewhere) are always read.
 */
const prefilter = (search: LibrarySearch): { readonly where: string; readonly params: ReadonlyArray<unknown> } => {
  if (search.regex) return { where: "", params: [] }
  if (search.matchCase)
    return { where: "AND (drafted OR kind = 'preset' OR instr(search_text, ?) > 0)", params: [search.find] }
  // LIKE folds ASCII letters only, so another letter could miss a differently cased match.
  if (!ascii.test(search.find)) return { where: "", params: [] }
  return {
    where: "AND (drafted OR kind = 'preset' OR search_text LIKE ? ESCAPE '\\')",
    params: [`%${escapeLike(search.find)}%`]
  }
}

const rejected = (message: string) =>
  new LibraryReplaceRejected({
    message: /timed out/i.test(message)
      ? "The search took too long. Narrow it, or simplify the regular expression."
      : message
  })

export const makeLibraryReplaceReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  /** The entries a search goes through, in the library's order; `refIds` narrows them. */
  const candidates = (
    userId: UserId,
    search: LibrarySearch,
    refIds: ReadonlyArray<string> | null,
    filtered: boolean
  ) => {
    const definitions = libraryReplaceKinds.list()
    if (search.kinds.some((kind) => !definitions.some((entry) => entry.id === kind)))
      return Effect.fail(rejected("That kind of entry can't be searched now."))
    const kindOrder = `CASE e.kind ${definitions.map((entry, i) => `WHEN '${entry.id.replaceAll("'", "''")}' THEN ${i}`).join(" ")} END`
    const filter = filtered ? prefilter(search) : { where: "", params: [] }
    const kinds = search.kinds.map(() => "?").join(", ")
    const only = refIds === null ? "" : `AND r.id IN (${refIds.map(() => "?").join(", ")})`
    return sql.unsafe<Candidate>(
      `SELECT entity_id, ref_id, kind, label, subtitle, head, row_version, drafted FROM (
        SELECT r.entity_id, r.id AS ref_id, e.kind, r.label, r.subtitle, r.head_revision_id AS head, r.row_version,
          EXISTS (SELECT 1 FROM drafts d WHERE d.user_id = ? AND d.target_kind = 'entity_field'
            AND d.target_id = r.id AND d.status = 'active') AS drafted,
          ${kindOrder} AS kind_order, h.search_text
        FROM entity_refs r JOIN entities e ON e.id = r.entity_id JOIN entity_revisions h ON h.id = r.head_revision_id
        WHERE e.owner_user_id = ? AND e.kind IN (${kinds}) AND e.deleted_at IS NULL AND e.archived_at IS NULL ${only}
          AND (e.kind <> 'note' OR ((SELECT f.origin FROM entity_revisions f WHERE f.entity_id = e.id
              ORDER BY f.seq LIMIT 1) IS NOT 'generation'
            AND json_extract(h.doc_json, '$.owner.chat') IS NULL))
      ) c WHERE 1 = 1 ${filter.where}
      ORDER BY kind_order, label COLLATE NOCASE, ref_id`,
      [userId, userId, ...search.kinds, ...(refIds ?? []), ...filter.params]
    )
  }

  const docs = (heads: ReadonlyArray<string>) =>
    heads.length === 0
      ? Effect.succeed(new Map<string, Doc>())
      : sql
          .unsafe<{ id: string; doc_json: string }>(
            `SELECT id, doc_json FROM entity_revisions WHERE id IN (${heads.map(() => "?").join(", ")})`,
            heads
          )
          .pipe(Effect.map((rows) => new Map(rows.map((row) => [row.id, JSON.parse(row.doc_json) as Doc]))))

  /** An entry as its editor shows it: the head, its unsaved changes on it where they apply. */
  const working = (userId: UserId, candidate: Candidate, head: Doc) =>
    Effect.gen(function* () {
      const base = editedDoc(candidate.kind, head)
      const rows =
        candidate.drafted === 1
          ? yield* sql<DraftRow>`SELECT id, field, content, row_version FROM drafts WHERE user_id = ${userId}
              AND target_kind = 'entity_field' AND target_id = ${candidate.ref_id} AND status = 'active'
              ORDER BY field, id`
          : []
      const stamp = [candidate.head, candidate.row_version, ...rows.map((row) => `${row.id}@${row.row_version}`)].join(
        ":"
      )
      if (rows.length === 0) return { candidate, doc: base, blocked: null, stamp } satisfies Working
      // Searched with the unsaved text where it applies, so the list shows what the editor shows,
      // but never replaced in.
      const applied = rows.some((row) => isHeldField(row.field)) ? null : applyDrafts(candidate.kind, base, rows)
      const doc = applied !== null && applied.problems.length === 0 ? editedDoc(candidate.kind, applied.doc) : base
      return { candidate, doc, blocked: LIBRARY_UNSAVED_REASON, stamp } satisfies Working
    })

  /** The entries, as their editors show them, a batch of documents at a time. */
  const workings = (userId: UserId, list: ReadonlyArray<Candidate>) =>
    Effect.gen(function* () {
      const out: Array<Working> = []
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH)
        const heads = yield* docs([...new Set(batch.map((c) => c.head))])
        for (const candidate of batch) out.push(yield* working(userId, candidate, heads.get(candidate.head)!))
      }
      return out
    })

  /** Every field's matches, the texts scanned a few megabytes at a time. */
  const scan = (search: LibrarySearch, entries: ReadonlyArray<Working>) =>
    Effect.gen(function* () {
      const fields = entries.map((entry) => libraryTextFields(entry.candidate.kind, entry.doc))
      const flat = fields.flatMap((list, entry) => list.map((field) => ({ entry, field })))
      const results: Array<Array<Scanned>> = entries.map(() => [])
      const pairs = [{ find: search.find, replace: search.replace }]
      let start = 0
      while (start < flat.length) {
        let end = start
        let size = 0
        while (end < flat.length && (end === start || size + flat[end]!.field.text.length <= SCAN_CHARS)) {
          size += flat[end]!.field.text.length
          end++
        }
        const chunk = flat.slice(start, end)
        const scanned = yield* scanHistory(
          chunk.map((item) => item.field.text),
          { ...search, pairs },
          SCAN_TIMEOUT
        ).pipe(Effect.mapError((error) => rejected(error.message)))
        chunk.forEach((item, i) => {
          const found = scanned[i]!
          if (found.matches.length > 0)
            results[item.entry]!.push({ field: item.field, matches: found.matches, after: found.after })
        })
        start = end
      }
      return results
    })

  const excerptOf = (text: string, match: Match): FieldExcerpt => {
    const flat = (part: string) => part.replace(/\s+/g, " ")
    const from = Math.max(0, match.start - AROUND)
    const to = Math.min(text.length, match.end + AROUND)
    const before = flat(text.slice(from, match.start))
    const found = flat(text.slice(match.start, match.end))
    return {
      text: before + found + flat(text.slice(match.end, to)),
      at: before.length,
      length: found.length,
      replacement: match.replacement,
      before: from > 0,
      after: to < text.length
    }
  }

  const fieldKey = (path: FieldPath) => textField(path)

  return {
    PreviewLibraryReplace: ({ userId, search }: { readonly userId: UserId; readonly search: LibrarySearch }) =>
      Effect.gen(function* () {
        const [total] = yield* sql.unsafe<{ n: number }>(
          `SELECT count(*) AS n FROM entity_refs r JOIN entities e ON e.id = r.entity_id
           WHERE e.owner_user_id = ? AND e.kind IN (${search.kinds.map(() => "?").join(", ")})
             AND e.deleted_at IS NULL AND e.archived_at IS NULL`,
          [userId, ...search.kinds]
        )
        const entries = yield* workings(userId, yield* candidates(userId, search, null, true))
        const scanned = yield* scan(search, entries)
        const hits: Array<LibraryEntryHit> = []
        entries.forEach((entry, i) => {
          const found = scanned[i]!
          if (found.length === 0) return
          hits.push({
            refId: entry.candidate.ref_id as LibraryEntryHit["refId"],
            kind: entry.candidate.kind,
            label: entry.candidate.label,
            subtitle: entry.candidate.subtitle,
            stamp: entry.stamp,
            unsaved: entry.candidate.drafted === 1,
            blocked: entry.blocked,
            count: found.reduce((n, f) => n + f.matches.length, 0),
            fields: found.map((f) => ({
              field: fieldKey(f.field.path),
              label: f.field.label,
              count: f.matches.length,
              excerpt: excerptOf(f.field.text, f.matches[0]!)
            }))
          })
        })
        const counts = search.kinds.map((kind) => {
          const of = hits.filter((hit) => hit.kind === kind)
          return { kind, entries: of.length, matches: of.reduce((n, hit) => n + hit.count, 0) }
        })
        return { entries: hits, counts, searched: total?.n ?? 0 } satisfies LibraryPreview
      }).pipe(query("PreviewLibraryReplace")),

    PlanLibraryReplace: ({
      userId,
      search,
      choices
    }: {
      readonly userId: UserId
      readonly search: LibrarySearch
      readonly choices: ReadonlyArray<LibraryChoice>
    }) =>
      Effect.gen(function* () {
        const chosen = new Map(choices.map((choice) => [choice.refId as string, choice]))
        const found =
          chosen.size === 0 ? [] : yield* workings(userId, yield* candidates(userId, search, [...chosen.keys()], false))
        const byRef = new Map(found.map((entry) => [entry.candidate.ref_id, entry]))
        const skipped: Array<LibrarySkipped> = []
        const skip = (refId: string, label: string, reason: string) =>
          skipped.push({ refId: refId as LibrarySkipped["refId"], label, reason })
        const current: Array<Working> = []
        for (const choice of choices) {
          const entry = byRef.get(choice.refId)
          if (entry === undefined) skip(choice.refId, "", "It's no longer in the library.")
          else if (choice.unsaved === true || entry.blocked !== null)
            skip(choice.refId, entry.candidate.label, LIBRARY_UNSAVED_REASON)
          else if (entry.stamp !== choice.stamp)
            skip(choice.refId, entry.candidate.label, "It changed since the search. Find again to include it.")
          else current.push(entry)
        }
        const scanned = yield* scan(search, current)
        const entries: Array<LibraryReplaceEntry> = []
        current.forEach((entry, i) => {
          const { candidate } = entry
          const fields = new Set(chosen.get(candidate.ref_id)!.fields)
          const picked = scanned[i]!.filter((f) => fields.has(fieldKey(f.field.path)) && f.after !== f.field.text)
          if (picked.length === 0) return skip(candidate.ref_id, candidate.label, "Nothing chosen in it changes.")
          const replaced = withValues(
            entry.doc,
            picked.map((f) => ({ path: f.field.path, value: f.after }))
          )
          const valid = replaced === null ? null : libraryReplaceKinds.get(candidate.kind)!.validate(replaced)
          if (valid === null || !valid.ok)
            return skip(candidate.ref_id, candidate.label, "The replacement wouldn't make a valid document.")
          // The user's own replace keeps an approved script approved, and an unapproved one is
          // still unapproved (owner, 2026-11-13). Approval is only ever the document's own flag here.
          const scripts = (valid.doc.regex ?? []) as ReadonlyArray<{ id: string; name: string }>
          const old = (entry.doc.regex ?? []) as ReadonlyArray<{ id: string; name: string }>
          const approvedScripts =
            entry.doc.regex_approved === true && valid.doc.regex_approved === true
              ? scripts
                  .filter((script) => canonicalJson(script) !== canonicalJson(old.find((s) => s.id === script.id)))
                  .map((script) => script.name)
              : []
          entries.push({
            refId: candidate.ref_id as LibraryReplaceEntry["refId"],
            label: candidate.label,
            head: candidate.head,
            rowVersion: candidate.row_version,
            doc: valid.doc,
            matches: picked.reduce((n, f) => n + f.matches.length, 0),
            approvedScripts
          })
        })
        return { entries, skipped }
      }).pipe(query("PlanLibraryReplace")),

    ListLibraryEdits: ({ userId, limit }: { readonly userId: UserId; readonly limit: number }) =>
      sql<{ id: string; title: string; created_at: number; entries: number; matches: number; undone: number }>`
        SELECT g.id, g.title, g.created_at, count(*) AS entries, sum(i.matches) AS matches,
          count(i.undone_by_revision_id) AS undone
        FROM changeset_groups g JOIN library_edit_items i ON i.group_id = g.id
        WHERE g.owner_user_id = ${userId}
        GROUP BY g.id ORDER BY g.created_at DESC, g.id DESC LIMIT ${limit}`.pipe(
        Effect.map((rows) =>
          rows.map((row): LibraryEdit => ({
            id: row.id,
            title: row.title,
            createdAt: row.created_at,
            entries: row.entries,
            matches: row.matches,
            undone: row.undone
          }))
        ),
        query("ListLibraryEdits")
      )
  }
})
