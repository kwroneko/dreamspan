// The re-import preview's reads (ARCHITECTURE.md §13 "Re-import preview"), in a reader
// worker: a dry run of the ST import's matcher over one batch of a chat file, and the stamp
// the import is checked against when the user confirms. The matcher is the writer's own
// (`placeStMessages`); here its writes only count, so what the preview shows is what the
// writer decides, with nothing stored.
import type { ChatId } from "@rp/shared/chat.ts"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { PLAN_TEXT_CHARS, type StPlanCounts, StPlanMessage } from "@rp/shared/stReimportPlan.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps, ST_CHAT_RECORD } from "./ops.ts"
import type { ForkRow } from "./rows.ts"
import {
  claimedPayload,
  type OverlaySlot,
  type OverlayVersion,
  type PlaceEvent,
  type PlaceOverlay,
  placeHash,
  type PlaceWrites,
  placeStMessages,
  type RecordPayload,
  StPlacedMessages
} from "./stImportPlace.ts"
import { stImportPlanStamp } from "./stImportPlanStamp.ts"
import { query } from "./tx.ts"

const VIRTUAL = "virtual:"

/** The start of a message's text for a detail row, on one line. */
const excerpt = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > PLAN_TEXT_CHARS ? `${line.slice(0, PLAN_TEXT_CHARS - 1)}…` : line
}

export const makeStImportPlanReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  /**
   * The record's fork, read only: `StImportClaim` would make a fork for an old record whose
   * fork is gone, branched from the chat's current fork with nothing of its own yet, so the
   * current fork shows what it would.
   */
  const recordFork = Effect.fnUntraced(function* (payload: RecordPayload) {
    const [existing] = yield* sql<ForkRow>`SELECT * FROM forks WHERE chat_id = ${payload.chatId}
      AND (id = ${payload.forkId ?? ""} OR (${payload.forkId ?? null} IS NULL
        AND tip_slot_id IS ${payload.end ?? payload.last ?? null}))
      ORDER BY id = ${payload.forkId ?? ""} DESC, created_at, id LIMIT 1`
    if (existing) return existing
    if (payload.forkId !== undefined) return yield* new NotFound({ entity: "fork", id: payload.forkId })
    const [current] = yield* sql<ForkRow>`SELECT f.* FROM forks f JOIN chats c ON c.current_fork_id = f.id
      WHERE c.id = ${payload.chatId}`
    if (!current) return yield* new NotFound({ entity: "fork", id: payload.chatId })
    return current
  })

  const handlers = {
    StImportPlanBatch: (input) =>
      Effect.gen(function* () {
        const messages = yield* Schema.decodeEffect(StPlacedMessages)(input.messagesJson).pipe(Effect.orDie)
        const [row] = yield* sql<{ payload_json: string }>`SELECT payload_json FROM jobs
          WHERE id = ${input.recordId} AND owner_user_id = ${input.userId} AND kind = ${ST_CHAT_RECORD}`
        if (!row) return yield* new NotFound({ entity: "import record", id: input.recordId })
        const record = JSON.parse(row.payload_json) as RecordPayload
        const [chat] = yield* sql<{ id: string; title: string; kind: string }>`SELECT id, title, kind FROM chats
          WHERE id = ${record.chatId} AND owner_user_id = ${input.userId} AND deleted_at IS NULL`
        if (!chat || !chatKinds.get(chat.kind)?.allowsStImport)
          return yield* new NotFound({ entity: "chat", id: record.chatId })
        const fork = yield* recordFork(record)
        // As the record would read when its batch is written: claimed by the run, or for a
        // branch's first import a new record on a new fork from its parent's (`StImportStartChat`),
        // which inherits everything the parent's shows; then what earlier batches left.
        const base: RecordPayload = input.branch
          ? { source: "", chatId: chat.id, forkId: fork.id, merged: true }
          : claimedPayload(record, fork.id, null)
        const payload: RecordPayload =
          input.carry === null
            ? base
            : {
                ...base,
                keepTip: input.carry.keepTip,
                branchDeleted: input.carry.branchDeleted,
                last: input.carry.last
              }
        const overlay = input.overlayJson === null ? null : (JSON.parse(input.overlayJson) as PlaceOverlay)
        const parent =
          input.parent === null
            ? null
            : input.matching && !input.parent.id.startsWith(VIRTUAL)
              ? yield* sql<{ id: string; depth: number }>`SELECT id, depth FROM slots
                  WHERE id = ${input.parent.id} AND chat_id = ${chat.id}`.pipe(
                  Effect.flatMap(([slot]) =>
                    slot ? Effect.succeed(slot) : Effect.fail(new NotFound({ entity: "slot", id: input.parent!.id }))
                  )
                )
              : input.parent
        // Ids no stored row has, unique in the preview; with `track`, what each write would be.
        let made = 0
        const virtual = () => `${input.virtualPrefix}${made++}`
        const slots: Array<OverlaySlot> = []
        const versions: Array<{ slotId: string; version: OverlayVersion }> = []
        const selects: Array<{ slotId: string; versionId: string }> = []
        const writerOf = (message: { readonly user: boolean }) => (message.user ? "human" : "model")
        const counting: PlaceWrites<never> = {
          copy: () => Effect.sync(virtual),
          addVersion: (slotId, ordinal, version, message) =>
            Effect.sync(() => {
              const id = virtual()
              if (input.track)
                versions.push({
                  slotId,
                  version: { id, hash: placeHash(version.content), at: version.at, writer: writerOf(message), ordinal }
                })
              return id
            }),
          select: (slotId, versionId) =>
            Effect.sync(() => {
              if (input.track) selects.push({ slotId, versionId })
            }),
          newSlot: (message, chosen, parent, depth) =>
            Effect.sync(() => {
              const id = virtual()
              if (input.track) {
                const own = message.versions.map((version, ordinal) => ({
                  id: `${id}#${ordinal}`,
                  hash: placeHash(version.content),
                  at: version.at,
                  writer: writerOf(message),
                  ordinal
                }))
                slots.push({
                  id,
                  parent: parent?.id ?? null,
                  depth,
                  hidden: message.hidden,
                  versions: own,
                  selected: own[chosen]!.id
                })
              }
              return id
            }),
          bulk: null
        }
        const counts: { -readonly [K in keyof StPlanCounts]: number } = {
          unchanged: 0,
          newMessages: 0,
          newSwipes: 0,
          selected: 0,
          kept: 0,
          branches: 0
        }
        const details: Array<StPlanMessage> = []
        let changed = 0
        const observe = (event: PlaceEvent) => {
          const message = messages[event.index]!
          let change: StPlanMessage["change"] | null
          let kept: StPlanMessage["kept"] = null
          if (event.outcome === "new") {
            counts.newMessages++
            if (event.branchFrom) counts.branches++
            change = event.branchFrom ? "branch" : "new"
          } else {
            kept =
              event.deleted || event.placeholder
                ? "deleted"
                : event.differs
                  ? event.hiddenDiffers
                    ? "hidden"
                    : "choice"
                  : null
            counts.newSwipes += event.addedVersions
            if (event.selected) counts.selected++
            if (kept !== null) counts.kept++
            change = event.addedVersions > 0 ? "swipes" : event.selected ? "selected" : kept !== null ? "kept" : null
            if (change === null) counts.unchanged++
          }
          if (change === null) return
          changed++
          if (details.length >= input.detailLimit) return
          const chosen = message.selected < message.versions.length ? message.selected : 0
          details.push(
            new StPlanMessage({
              index: input.firstIndex + event.index,
              change,
              swipes: event.addedVersions,
              kept,
              user: message.user,
              text: excerpt(message.versions[chosen]!.content)
            })
          )
        }
        const placed = yield* placeStMessages(
          sql,
          {
            chatId: chat.id,
            fileFork: fork,
            payload,
            parent,
            messages,
            matching: input.matching,
            strict: input.strict,
            overlay
          },
          counting,
          observe
        )
        const last = placed.slotIds.at(-1)
        const depth = (parent?.depth ?? -1) + messages.length
        return {
          chatId: chat.id as ChatId,
          chatTitle: chat.title,
          cursor:
            last === undefined
              ? input.parent === null
                ? null
                : { ...input.parent, virtual: input.parent.id.startsWith(VIRTUAL) }
              : { id: last, depth, virtual: last.startsWith(VIRTUAL) },
          matching: placed.matching,
          counts,
          carry: {
            keepTip: placed.keepTip,
            branchDeleted: placed.branchDeleted,
            last: last === undefined || last.startsWith(VIRTUAL) ? (payload.last ?? null) : last
          },
          messages: details,
          changed,
          written: input.track ? JSON.stringify({ slots, versions, selects } satisfies PlaceOverlay) : null
        }
      }).pipe(query("StImportPlanBatch")),
    StImportPlanStamp: ({ userId, chatIds }) => stImportPlanStamp(sql, userId, chatIds).pipe(query("StImportPlanStamp"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
