// Where an ST chat file's messages go (ARCHITECTURE.md §13 "Re-running is idempotent"): the
// matcher that maps each incoming message to a slot already in the chat, or starts new ones.
// One code path for two callers. The writer (`StImportMessages`, stImportWrites.ts) runs it
// inside its transaction with writes that store; the re-import preview (`StImportPlanBatch`,
// stImportPlanReads.ts) runs it in a reader worker with writes that only count, so the plan a
// user is shown is the matcher's own decision, not a second implementation of it. Every read
// here is a plain query; every change goes through `PlaceWrites`.
import type { SlotId } from "@rp/shared/chat.ts"
import { ReplySections } from "@rp/shared/replySections.ts"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { placedInsertions } from "./displayPath.ts"
import { lineageCte } from "./forkLabels.ts"
import { effectiveOverride, eventApplies, selectedIn, slotDeletedIn, versionDeletedIn, withFork } from "./forkState.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { NotFound } from "./ops.ts"
import { pathSegments } from "./pathSegments.ts"
import { type ForkRow, StoredGeneration } from "./rows.ts"

/** A message as the format worker wrote it (formats/stChat.ts). */
export const StPlacedMessage = Schema.Struct({
  arrivalAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  user: Schema.Boolean,
  hidden: Schema.Boolean,
  speaker: Schema.NullOr(Schema.String),
  selected: Schema.Int,
  versions: Schema.NonEmptyArray(
    Schema.Struct({
      content: Schema.String,
      reasoning: Schema.NullOr(Schema.String),
      sections: Schema.optionalKey(ReplySections),
      at: Schema.Number,
      /** Its model, times and token count as ST recorded them (formats/stChat.ts; rows.ts `recordedColumns`). */
      generation: Schema.optionalKey(StoredGeneration)
    })
  )
})
export type StPlacedMessage = typeof StPlacedMessage.Type
export type StPlacedVersion = StPlacedMessage["versions"][number]
export const StPlacedMessages = Schema.fromJsonString(Schema.Array(StPlacedMessage))

/** What a record's payload holds. */
export interface RecordPayload {
  readonly source: string
  readonly forkId?: string
  readonly chatId: string
  readonly sha256?: string
  readonly state?: string
  readonly notes?: Record<string, string>
  /** The file's last slot when its import last finished. */
  readonly end?: string | null
  /** The file went into another file's chat: it's a branch of it. */
  readonly merged?: boolean
  /** The first slot the import running now added, for a run that resumes it. */
  readonly firstAdded?: string | null
  /** The chat's own title, while it shows as an unfinished import. */
  readonly title?: string
  /** Where the import last moved a new chat's leaf to, while its messages came in. */
  readonly advanced?: string | null
  /** The import run that may write the file now; null once it's finished. */
  readonly lease?: string | null
  /** The last slot an import of the file wrote or matched, as it went. */
  readonly last?: string | null
  /**
   * Where the file's earlier imports left it (`last` when this run claimed the record): the
   * slots on the path to it are the file's, whatever the user changed in them since.
   */
  readonly prior?: string | null
  /** Original suffix while a shared selection is being forked, including across interrupted batches. */
  readonly forkPrior?: string | null
  /** This pass matched a deleted subtree root; later live additions remain behind it. */
  readonly branchDeleted?: boolean
  /** A replacement ST path must not move the fork off locally changed history. */
  readonly keepTip?: boolean
  /** ST opened the file's card or group on it when the folder was read (`stCurrent`). */
  readonly stCurrent?: boolean
  /** Last resolved parent, retained when a later header loses main_chat. */
  readonly parentRecordId?: string
  /** Where the file's first import's state applies from (`StChatRecord.stateAt`). */
  readonly stateAt?: number
}

/** The record as `StImportClaim` leaves it for the run that claims it: what matching reads. */
export const claimedPayload = (payload: RecordPayload, forkId: string, lease: string | null): RecordPayload => ({
  ...payload,
  lease,
  prior: payload.last ?? payload.end ?? null,
  forkId,
  branchDeleted: false
})

interface PlaceSlot {
  readonly id: string
  readonly depth: number
}

/** What placing one message did, for the re-import preview. */
export interface PlaceEvent {
  /** Its index among the messages given. */
  readonly index: number
  readonly outcome: "matched" | "new"
  /** Swipes the message gained. */
  readonly addedVersions: number
  /** The file's selected swipe is now the one shown here. */
  readonly selected: boolean
  /** Here it shows another swipe, or hides it differently, and keeps that. */
  readonly differs: boolean
  /** The user selected, edited, hid or deleted something in it here. */
  readonly locallyChanged: boolean
  /** It's deleted here (in the recycle bin, or deleted for good). */
  readonly deleted: boolean
  readonly hiddenDiffers: boolean
  /** It was deleted for good here: its place is kept, its text isn't brought back. */
  readonly placeholder: boolean
  /** The first new message where messages are already there: a new branch starts. */
  readonly branchFrom: boolean
}

/** Every change the matcher makes. The writer stores; the preview only counts. */
export interface PlaceWrites<E> {
  /** A resumed suffix copy (`forkImportSlot`): the copy's slot. */
  readonly copy: (source: string, parentId: string | null) => Effect.Effect<string, E>
  /** A version the matched slot lacks. */
  readonly addVersion: (
    slotId: string,
    ordinal: number,
    version: StPlacedVersion,
    message: StPlacedMessage
  ) => Effect.Effect<string, E>
  /** The file's selection, in the file's fork. */
  readonly select: (slotId: string, versionId: string, shown: StPlacedVersion) => Effect.Effect<void, E>
  /** A new slot with all the message's versions. */
  readonly newSlot: (
    message: StPlacedMessage,
    chosen: number,
    parent: PlaceSlot | null,
    depth: number
  ) => Effect.Effect<string, E>
  /** A prepared suffix of all the messages given, when the first of them is new (bulk inserts). */
  readonly bulk: ((parent: PlaceSlot | null) => Effect.Effect<ReadonlyArray<string>, E>) | null
}

/** A version's text as the preview's overlay compares it. */
export const placeHash = (content: string) => createHash("sha1").update(content).digest("base64")

/** A version the re-import preview would add: its text as `placeHash`. */
export interface OverlayVersion {
  readonly id: string
  readonly hash: string
  readonly at: number
  readonly writer: string
  readonly ordinal: number
}

/** A slot the re-import preview would add. */
export interface OverlaySlot {
  readonly id: string
  readonly parent: string | null
  readonly depth: number
  readonly hidden: boolean
  readonly versions: ReadonlyArray<OverlayVersion>
  readonly selected: string
}

/**
 * What the preview's earlier files would have written to the chat by the time this file's
 * batch is: the import writes a folder's files one after another, so a later file (a branch
 * whose copy shares the messages its parent file adds) matches those. Slots with ids that
 * aren't stored, versions added to slots, and selections the import would make.
 */
export interface PlaceOverlay {
  readonly slots: ReadonlyArray<OverlaySlot>
  readonly versions: ReadonlyArray<{ readonly slotId: string; readonly version: OverlayVersion }>
  readonly selects: ReadonlyArray<{ readonly slotId: string; readonly versionId: string }>
}

/** A matcher row of `placeStMessages`; `hash` for one from the overlay, whose text it stands for. */
interface ChildRow {
  slot_id: string
  version_id: string
  depth: number
  hidden: number
  selected: number
  content: string
  original: string
  created_at: number
  writer: string
  ordinal: number
  slot_purged: number
  version_purged: number
  branch_deleted: number
  deleted: number
  version_deleted: number
  locally_changed: number
  hash?: string
}

/** The overlay indexed for the matcher's lookups. */
const indexOverlay = (overlay: PlaceOverlay) => {
  const slots = new Map<string, { slot: OverlaySlot; versions: Array<OverlayVersion> }>()
  const children = new Map<string | null, Array<string>>()
  for (const slot of overlay.slots) {
    slots.set(slot.id, { slot, versions: [...slot.versions] })
    const list = children.get(slot.parent) ?? []
    list.push(slot.id)
    children.set(slot.parent, list)
  }
  const added = new Map<string, Array<OverlayVersion>>()
  for (const { slotId, version } of overlay.versions) {
    const own = slots.get(slotId)
    if (own !== undefined) own.versions.push(version)
    else added.set(slotId, [...(added.get(slotId) ?? []), version])
  }
  const selected = new Map(overlay.selects.map((x) => [x.slotId, x.versionId]))
  return { slots, children, added, selected }
}

const overlayRow = (
  slotId: string,
  depth: number,
  hidden: number,
  version: OverlayVersion,
  selected: boolean
): ChildRow => ({
  slot_id: slotId,
  version_id: version.id,
  depth,
  hidden,
  selected: selected ? 1 : 0,
  content: "",
  original: "",
  created_at: version.at,
  writer: version.writer,
  ordinal: version.ordinal,
  slot_purged: 0,
  version_purged: 0,
  branch_deleted: 0,
  deleted: 0,
  version_deleted: 0,
  locally_changed: 0,
  hash: version.hash
})

/** The stored children of `parent` with what the overlay adds: versions, selections and new slots. */
const withOverlay = (
  stored: ReadonlyArray<ChildRow>,
  index: ReturnType<typeof indexOverlay>,
  parent: PlaceSlot | null
): Array<ChildRow> => {
  const rows: Array<ChildRow> = []
  const bySlot = new Map<string, Array<ChildRow>>()
  for (const row of stored) bySlot.set(row.slot_id, [...(bySlot.get(row.slot_id) ?? []), row])
  for (const [slotId, own] of bySlot) {
    const choice = index.selected.get(slotId)
    for (const row of own)
      rows.push(choice === undefined ? row : { ...row, selected: row.version_id === choice ? 1 : 0 })
    const first = own[0]!
    for (const version of index.added.get(slotId) ?? [])
      rows.push({
        ...overlayRow(slotId, first.depth, first.hidden, version, choice === version.id),
        locally_changed: first.locally_changed,
        deleted: first.deleted,
        branch_deleted: first.branch_deleted
      })
  }
  // Stored slots first, as the query orders them; the overlay's after, oldest first.
  for (const slotId of index.children.get(parent?.id ?? null) ?? []) {
    const { slot, versions } = index.slots.get(slotId)!
    const choice = index.selected.get(slotId) ?? slot.selected
    for (const version of versions)
      rows.push(overlayRow(slot.id, slot.depth, slot.hidden ? 1 : 0, version, version.id === choice))
  }
  return rows
}

export interface PlaceInput {
  readonly chatId: string
  readonly fileFork: ForkRow
  readonly payload: RecordPayload
  readonly parent: PlaceSlot | null
  readonly messages: ReadonlyArray<StPlacedMessage>
  readonly matching: boolean
  /** A branch merged into another file's chat (see `StImportMessages.strict`). */
  readonly strict: boolean
  /** The preview's: what its earlier files would have written (`PlaceOverlay`). */
  readonly overlay?: PlaceOverlay | null
}

interface Placed {
  readonly slotIds: ReadonlyArray<SlotId>
  readonly matching: boolean
  readonly added: number
  readonly updated: number
  readonly differing: number
  readonly firstAdded: string | null
  readonly branchDeleted: boolean
  readonly keepTip: boolean
  readonly invalidatesPrefix: boolean
}

/**
 * Places `messages` under `parent`. While matching, a message that matches a child already
 * there (a version with the same text, or the text it had before the user amended it, and
 * time, by the same kind of writer) is that child, taking any versions it lacks; on this file's
 * recorded prior path, position and writer identify a live slot even when ST overwrote its
 * text. The first that doesn't match starts new slots.
 */
export const placeStMessages = <E>(
  sql: SqlClient.SqlClient,
  input: PlaceInput,
  writes: PlaceWrites<E>,
  observe: (event: PlaceEvent) => void
) =>
  Effect.gen(function* () {
    const { chatId, fileFork, payload, messages } = input
    let parent = input.parent
    const overlay = input.overlay == null ? null : indexOverlay(input.overlay)
    const hashes = new Map<StPlacedVersion, string>()
    const hashOf = (version: StPlacedVersion) => {
      let hash = hashes.get(version)
      if (hash === undefined) hashes.set(version, (hash = placeHash(version.content)))
      return hash
    }
    const ownedSlot = (slotId: string) =>
      sql<{ id: string; depth: number }>`SELECT id, depth FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}`.pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "slot", id: slotId }))
        )
      )
    const shownSql = selectedIn(sql, fileFork.id, "s")
    // The slots on the path to where earlier imports of the file left it, by depth, from
    // the batch's first message down: walked once, and only if a message doesn't match exactly.
    let priorPath: Map<number, string> | null = null
    const forkPrior = payload.forkPrior ?? null
    const firstDepth = parent === null ? 0 : parent.depth + 1
    const priorAt = (depth: number) =>
      Effect.gen(function* () {
        if (priorPath === null) {
          priorPath = new Map<number, string>()
          if (payload.prior == null && forkPrior === null) return undefined
          // The old suffix fills positions not yet copied. A resumed copy's new path
          // takes precedence at positions its earlier batches already wrote.
          if (forkPrior !== null) {
            const rows = yield* sql<{ id: string; depth: number }>`
              WITH RECURSIVE up(id, parent, depth) AS (
                SELECT id, parent_slot_id, depth FROM slots WHERE id = ${forkPrior} AND chat_id = ${chatId}
                UNION ALL
                SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN up ON s.id = up.parent WHERE up.depth > ${firstDepth}
              ) SELECT id, depth FROM up`
            for (const row of rows) priorPath.set(row.depth, row.id)
          }
          const rows = yield* sql<{ id: string; depth: number }>`
            WITH RECURSIVE up(id, parent, depth) AS (
              SELECT id, parent_slot_id, depth FROM slots WHERE id = ${payload.prior} AND chat_id = ${chatId}
              UNION ALL
              SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN up ON s.id = up.parent WHERE up.depth > ${firstDepth}
            )
            SELECT id, depth FROM up`
          for (const row of rows) priorPath.set(row.depth, row.id)
        }
        return priorPath.get(depth)
      })
    let matching = input.matching
    let added = 0
    let differing = 0
    let updated = 0
    let branchDeleted = payload.branchDeleted ?? false
    let keepTip = payload.keepTip ?? false
    let invalidatesPrefix = false
    const changedSuffix = Effect.fnUntraced(function* (depth: number) {
      const prior = payload.prior ?? payload.end ?? payload.last ?? null
      if (prior === null || (yield* ownedSlot(prior)).depth < depth) return false
      // A message the user inserted in the fork where the replaced suffix starts (below its
      // parent, or above the first message) or inside it: the fork stays on the path that
      // shows it (spec/MESSAGE-INSERT.md §3.3). Deleted ones count, as a deletion does.
      const inserted = (yield* placedInsertions(sql, chatId, fileFork.id)).filter((x) =>
        x.anchorDepth === null ? depth === 0 : x.anchorDepth >= depth - 1
      )
      if (inserted.length > 0) {
        const [row] = yield* sql<{ n: number }>`
          ${pathSegments(sql, chatId, prior, null)}
          SELECT count(*) AS n FROM slots a JOIN segments g ON g.chain_id = a.chain_id AND a.depth BETWEEN g.lo AND g.hi
          WHERE a.id IN (SELECT value FROM json_each(${JSON.stringify(inserted.map((x) => x.anchorId))}))`
        if (inserted.some((x) => x.anchorId === null) || row!.n > 0) return true
      }
      const [row] = yield* sql<{ changed: number }>`
        ${pathSegments(sql, chatId, prior, null)}, ${withFork(sql, fileFork.id, (f) => lineageCte("lineage", f))}, changed(slot_id) AS (
          SELECT o.slot_id FROM lineage l CROSS JOIN fork_overrides o
            ON o.fork_id = l.fork_id AND o.seq <= l.bound
          WHERE o.origin = 'user' AND o.slot_depth >= ${depth}
          UNION ALL
          SELECT v.slot_id FROM version_history h JOIN versions v ON v.id = h.version_id
            JOIN slots s ON s.id = v.slot_id
          WHERE s.chat_id = ${chatId} AND s.depth >= ${depth} AND v.fork_id IS NULL
          UNION ALL
          SELECT e.slot_id FROM state_events e WHERE e.chat_id = ${chatId} AND e.origin <> 'import'
            AND e.slot_depth >= ${depth} AND ${eventApplies(sql, fileFork.id, "e")}
        ) SELECT EXISTS (SELECT 1 FROM changed c JOIN slots s ON s.id = c.slot_id
          JOIN segments g ON g.chain_id = s.chain_id AND s.depth BETWEEN g.lo AND g.hi) AS changed`
      return row?.changed === 1
    })
    let firstAdded: string | null = null
    const slotIds: Array<SlotId> = []
    for (const [offset, message] of messages.entries()) {
      const writer = message.user ? "human" : "model"
      const chosen = message.selected < message.versions.length ? message.selected : 0
      let branchFrom = false
      if (matching) {
        let copied: string | null = null
        if (forkPrior !== null) {
          const source = yield* priorAt(parent === null ? 0 : parent.depth + 1)
          if (source !== undefined) {
            const [position] = yield* sql<{ parent: string | null; writer_matches: number }>`
              SELECT s.parent_slot_id AS parent, EXISTS (
                SELECT 1 FROM versions v WHERE v.slot_id = s.id AND v.writer = ${writer}
              ) AS writer_matches FROM slots s WHERE s.id = ${source}`
            if (position?.writer_matches === 1 && position.parent !== (parent?.id ?? null)) {
              copied = yield* writes.copy(source, parent?.id ?? null)
              priorPath!.set(parent === null ? 0 : parent.depth + 1, copied)
            }
          }
        }
        // Messages in the bin match too: a re-import doesn't bring back what was deleted here.
        // A version the user amended matches by the text it had before (`original`, its
        // oldest history entry), so it isn't imported again beside the amended one.
        const stored =
          overlay !== null && parent !== null && overlay.slots.has(parent.id)
            ? []
            : yield* sql<ChildRow>`
          SELECT s.id AS slot_id, v.id AS version_id, s.depth,
            ${contextExcludedIn(sql, fileFork.id)} AS hidden,
            v.id = ${shownSql} AS selected,
            v.content, v.created_at, v.writer, v.ordinal,
            s.purged_at IS NOT NULL AS slot_purged, v.purged_at IS NOT NULL AS version_purged,
            s.branch_deleted,
            ${slotDeletedIn(sql, fileFork.id, "s")} AS deleted, ${versionDeletedIn(sql, fileFork.id, "v")} AS version_deleted,
            EXISTS (
              SELECT 1 FROM version_history h WHERE h.version_id = ${shownSql}
            ) OR EXISTS (
              SELECT 1 FROM fork_overrides o WHERE o.id IN (
                ${effectiveOverride(sql, "select", fileFork.id, "s.id")},
                ${effectiveOverride(sql, "hide", fileFork.id, "s.id")},
                ${effectiveOverride(sql, "delete_slot", fileFork.id, "s.id")}) AND o.origin = 'user'
            ) OR EXISTS (
              SELECT 1 FROM versions r JOIN fork_overrides o ON o.id IN (
                ${effectiveOverride(sql, "replace", fileFork.id, "r.id")},
                ${effectiveOverride(sql, "delete_version", fileFork.id, "r.id")})
              WHERE r.slot_id = s.id AND o.origin = 'user'
            ) AS locally_changed,
            coalesce((SELECT h.content FROM version_history h WHERE h.version_id = v.id ORDER BY h.id LIMIT 1),
              v.content) AS original
          FROM slots s JOIN version_records v ON v.slot_id = s.id AND v.fork_id IS NULL
          WHERE ${parent === null ? sql`s.chat_id = ${chatId} AND s.depth = 0` : sql`s.parent_slot_id = ${parent.id}`}
            AND s.inserted = 0
          ORDER BY s.id, v.ordinal`
        const children = overlay === null ? stored : withOverlay(stored, overlay, parent)
        const same = (row: ChildRow, version: StPlacedVersion) =>
          row.version_purged === 0 &&
          row.writer === writer &&
          row.created_at === version.at &&
          (row.hash !== undefined
            ? row.hash === hashOf(version)
            : row.content === version.content || row.original === version.content)
        const shown = message.versions[chosen]!
        const versionsOf = (slotId: string) => children.filter((row) => row.slot_id === slotId)
        // Every sibling with a version of the message: a branch that went its own way
        // has its own copy next to its parent's.
        const candidates = [
          ...new Set(
            children.filter((row) => message.versions.some((version) => same(row, version))).map((row) => row.slot_id)
          )
        ].map(versionsOf)
        // Whether a slot shows what the file shows, and hides what it hides.
        const alike = (own: typeof children) =>
          own.some((row) => row.selected === 1 && same(row, shown)) && own[0]!.hidden === (message.hidden ? 1 : 0)
        const exact = candidates.find(alike)
        // Otherwise the slot an earlier import of this file matched or made here, whatever
        // the user selected, hid or deleted in it since: the user's choices stay theirs.
        // A purged slot has no text left to match. Only this file's recorded path
        // may identify its placeholder, with the retained timestamp and writer.
        const purged = children.filter(
          (row) =>
            row.slot_purged === 1 &&
            row.writer === writer &&
            message.versions.some((version) => row.created_at === version.at)
        )
        const mine =
          exact !== undefined && purged.length === 0 && new Set(children.map((row) => row.slot_id)).size === 1
            ? undefined
            : yield* priorAt(parent === null ? 0 : parent.depth + 1)
        // On this file's recorded path, ST may have overwritten every old swipe.
        // Position identifies the slot even when text and swipe dates changed. A
        // different writer still starts a new path; purged text is never restored.
        const earlier = mine === undefined ? undefined : versionsOf(mine)
        const recorded = earlier?.some((row) => row.writer === writer && row.slot_purged === 0) ? earlier : undefined
        const placeholder = mine === undefined ? undefined : purged.find((row) => row.slot_id === mine)
        // A branch merged into another file's chat is that file's only where it reads
        // the same: a branch from another swipe, or with messages hidden only in it,
        // diverges there, so its own path keeps what ST had on it.
        const own =
          recorded ??
          exact ??
          candidates.find((rows) => rows[0]!.hidden === (message.hidden ? 1 : 0)) ??
          (input.strict ? undefined : candidates[0])
        const match = placeholder ?? own?.[0]
        if (match !== undefined) {
          // A copy, changed swipe or fork selection discards the fast path. An
          // unchanged subset of known swipes can safely populate another hash.
          if (copied !== null || placeholder !== undefined || match.branch_deleted === 1) invalidatesPrefix = true
          if (copied !== null) {
            added++
            firstAdded ??= copied
          }
          branchDeleted ||= match.branch_deleted === 1
          let showsSelected = own?.some((row) => row.selected === 1 && same(row, shown)) ?? false
          let addedVersions = 0
          let selectedNow = false
          if (own !== undefined && match.slot_purged === 0) {
            let next = Math.max(...own.map((row) => row.ordinal)) + 1
            let changed = false
            let selected = own.find((row) => same(row, shown) && row.version_deleted === 0)?.version_id
            for (const version of message.versions) {
              if (!own.some((row) => same(row, version))) {
                const id = yield* writes.addVersion(match.slot_id, next++, version, message)
                addedVersions++
                if (version === shown) selected = id
                changed = true
              }
            }
            // A local selection, edit, hide or deletion stays the user's. Import
            // selections advance their baseline with the slot's optimistic revision.
            if (!showsSelected && selected !== undefined && match.locally_changed === 0 && match.deleted === 0) {
              yield* writes.select(match.slot_id, selected, shown)
              showsSelected = true
              selectedNow = true
              changed = true
            }
            if (changed) {
              updated++
              invalidatesPrefix = true
            }
          }
          const hiddenDiffers = match.hidden !== (message.hidden ? 1 : 0)
          const differs = placeholder === undefined && (!showsSelected || hiddenDiffers)
          if (differs) {
            differing++
            invalidatesPrefix = true
          }
          observe({
            index: offset,
            outcome: "matched",
            addedVersions,
            selected: selectedNow,
            differs,
            locallyChanged: match.locally_changed === 1,
            deleted: match.deleted === 1 || match.slot_purged === 1,
            hiddenDiffers,
            placeholder: placeholder !== undefined,
            branchFrom: false
          })
          parent = { id: match.slot_id, depth: match.depth }
          slotIds.push(match.slot_id as SlotId)
          continue
        }
        // A writer change (or a new unmatched message) replaces the remaining
        // path. Keep a fork with local choices on that suffix on its existing
        // path, just as when it has a local continuation. Store ST's new path
        // in the record without moving the user off their work.
        keepTip ||= yield* changedSuffix(parent === null ? 0 : parent.depth + 1)
        matching = false
        branchFrom = children.length > 0
      }
      if (offset === 0 && writes.bulk !== null) {
        const ids = yield* writes.bulk(parent)
        for (const [index, id] of ids.entries()) {
          observe(newEvent(index, index === 0 && branchFrom))
          slotIds.push(id as SlotId)
        }
        firstAdded ??= ids[0] ?? null
        added += ids.length
        break
      }
      const depth = parent === null ? 0 : parent.depth + 1
      const slotId = yield* writes.newSlot(message, chosen, parent, depth)
      observe(newEvent(offset, branchFrom))
      firstAdded ??= slotId
      parent = { id: slotId, depth }
      slotIds.push(slotId as SlotId)
      added++
    }
    return {
      slotIds,
      matching,
      added,
      updated,
      differing,
      firstAdded,
      branchDeleted,
      keepTip,
      invalidatesPrefix
    } satisfies Placed
  })

/** A message placed as new; `branchFrom`: the first where messages are already there. */
export const newEvent = (index: number, branchFrom: boolean): PlaceEvent => ({
  index,
  outcome: "new",
  addedVersions: 0,
  selected: false,
  differs: false,
  locallyChanged: false,
  deleted: false,
  hiddenDiffers: false,
  placeholder: false,
  branchFrom
})
