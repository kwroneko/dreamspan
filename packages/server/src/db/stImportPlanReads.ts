// The re-import preview's reads (ARCHITECTURE.md §13 "Re-import preview"), in a reader
// worker: a dry run of the ST import's matcher over one batch of a chat file, and the stamps
// the confirmed import is checked against chat by chat. The matcher is the writer's own
// (`placeStMessages`), and so is the count of what it did (`planCounter`); here its writes
// only count, so what the preview shows is what the writer decides, with nothing stored.
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps, ST_CHAT_RECORD } from "./ops.ts"
import type { ForkRow } from "./rows.ts"
import {
  claimedPayload,
  type OverlaySlot,
  type OverlayVersion,
  type PlaceOverlay,
  placeHash,
  type PlaceWrites,
  placeStMessages,
  type RecordPayload,
  StPlacedMessages
} from "./stImportPlace.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { slotDeletedIn } from "./forkState.ts"
import { computeForkSummaries, FORK_SUMMARY_FORMAT, summaryStamps } from "./forkSummaries.ts"
import { planCounter } from "./stImportPlanCount.ts"
import type { StBatchPlan, StPlanOp } from "./stImportPlanOps.ts"
import { stImportChatStamp, stImportChatStamps } from "./stImportPlanStamp.ts"
import { query } from "./tx.ts"

const VIRTUAL = "virtual:"

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

  /** `end`, or the nearest slot above it live in fork `forkId` (`relocatedEnd`, stImportWrites.ts). */
  const relocatedEnd = (forkId: string, end: string) =>
    sql<{ id: string }>`WITH RECURSIVE up(id, parent, deleted, depth) AS (
      SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, forkId, "s")}, s.depth FROM slots s WHERE s.id = ${end}
      UNION ALL
      SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, forkId, "s")}, s.depth
      FROM slots s JOIN up ON s.id = up.parent WHERE up.deleted
    ) SELECT id FROM up WHERE NOT deleted ORDER BY depth DESC LIMIT 1`.pipe(Effect.map(([row]) => row?.id ?? null))

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
        // With `plan`, the writes are recorded with the ids the writer will give them. A resumed
        // shared-selection copy (`forkPrior`) is the one write the plan doesn't take: the writer
        // matches such a file itself.
        const planning = input.plan === true && (payload.forkPrior ?? null) === null
        const ops: Array<StPlanOp> = []
        const tail: { from: number; parent: { id: string; depth: number } | null; ids: Array<string> } = {
          from: -1,
          parent: null,
          ids: []
        }
        const indexOf = new Map(messages.map((message, index) => [message, index]))
        const recording: PlaceWrites<never> = {
          copy: () => Effect.die(new Error("a planned batch copies nothing")),
          addVersion: (slotId, ordinal, version, message) =>
            Effect.sync(() => {
              const id = uuidv7()
              ops.push({
                k: "v",
                slot: slotId,
                id,
                ordinal,
                m: indexOf.get(message)!,
                v: message.versions.indexOf(version)
              })
              return id
            }),
          select: (slotId, versionId, shown) =>
            Effect.sync(() => {
              const m = messages.findIndex((message) => message.versions.includes(shown))
              ops.push({ k: "s", slot: slotId, version: versionId, m, v: messages[m]!.versions.indexOf(shown) })
            }),
          newSlot: (message, _chosen, under) =>
            Effect.sync(() => {
              if (tail.from < 0) {
                tail.from = indexOf.get(message)!
                tail.parent = under === null ? null : { id: under.id, depth: under.depth }
              }
              const id = uuidv7()
              tail.ids.push(id)
              return id
            }),
          bulk: (under) =>
            Effect.sync(() => {
              tail.from = 0
              tail.parent = under === null ? null : { id: under.id, depth: under.depth }
              for (const _ of messages) tail.ids.push(uuidv7())
              return tail.ids
            })
        }
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
        const counter = planCounter(messages, input.firstIndex, input.detailLimit, input.digest)
        let unchangedPrefix = 0
        let prefixOpen = true
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
          planning ? recording : counting,
          (event) => {
            counter.observe(event)
            if (
              prefixOpen &&
              event.outcome === "matched" &&
              event.addedVersions === 0 &&
              !event.selected &&
              !event.differs &&
              !event.deleted &&
              !event.placeholder
            )
              unchangedPrefix++
            else prefixOpen = false
          }
        )
        const reusable =
          !input.branch && record.forkPrior == null && placed.branchDeleted === (payload.branchDeleted ?? false)
        const last = placed.slotIds.at(-1)
        const depth = (parent?.depth ?? -1) + messages.length
        let planJson: string | undefined
        if (planning) {
          const fresh = new Set(tail.ids)
          const stored = placed.slotIds.filter((id) => !fresh.has(id))
          const uncast =
            stored.length === 0
              ? []
              : (yield* sql<{ id: string }>`SELECT v.id FROM json_each(${JSON.stringify(stored)}) j
                  CROSS JOIN version_records v ON v.slot_id = j.value
                  WHERE v.origin = 'imported' AND v.cast_json IS NULL ORDER BY j.key, v.ordinal`).map((row) => row.id)
          const tip = last === undefined ? null : fresh.has(last) ? last : yield* relocatedEnd(fork.id, last)
          const plan: StBatchPlan = {
            stamp: (yield* stImportChatStamp(sql, input.userId, chat.id)) ?? "",
            ops,
            tail: tail.from < 0 ? null : tail,
            slotIds: placed.slotIds,
            matching: placed.matching,
            added: placed.added,
            updated: placed.updated,
            differing: placed.differing,
            firstAdded: placed.firstAdded,
            branchDeleted: placed.branchDeleted,
            keepTip: placed.keepTip,
            tip,
            uncast,
            counts: counter.counts,
            digest: counter.digest()
          }
          planJson = JSON.stringify(plan)
        }
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
          unchangedSlots: reusable
            ? placed.slotIds.slice(0, unchangedPrefix).filter((id) => !id.startsWith(VIRTUAL))
            : [],
          ...(input.compact && reusable && unchangedPrefix === messages.length && placed.matching
            ? {
                compactJson: JSON.stringify(
                  messages.map((message) => ({
                    ...message,
                    selected: 0,
                    versions: [
                      {
                        content: "",
                        reasoning: null,
                        at: message.versions[message.selected < message.versions.length ? message.selected : 0]!.at
                      }
                    ]
                  }))
                )
              }
            : {}),
          counts: counter.counts,
          carry: {
            keepTip: placed.keepTip,
            branchDeleted: placed.branchDeleted,
            last: last === undefined || last.startsWith(VIRTUAL) ? (payload.last ?? null) : last
          },
          messages: counter.details,
          changed: counter.changed(),
          written: input.track ? JSON.stringify({ slots, versions, selects } satisfies PlaceOverlay) : null,
          digest: counter.digest(),
          ...(planJson === undefined ? {} : { planJson })
        }
      }).pipe(query("StImportPlanBatch")),
    StImportPlanStamp: ({ userId }) => stImportChatStamps(sql, userId).pipe(query("StImportPlanStamp")),
    // What `refreshChatSummaries` would store at the end of the write, computed here.
    StImportChatSummaries: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ shell_stamp: number }>`SELECT shell_stamp FROM chats
          WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (chat === undefined) return null
        const userStamp = yield* summaryStamps(sql, userId)
        const records = yield* sql<ForkRow>`SELECT f.* FROM forks f LEFT JOIN fork_summaries s ON s.fork_id = f.id
          WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL AND (s.fork_id IS NULL OR s.format <> ${FORK_SUMMARY_FORMAT}
            OR s.stamp <> ${chat.shell_stamp} OR s.user_stamp <> ${userStamp})`
        if (records.length === 0) return null
        const forks = yield* computeForkSummaries(sql, records, records.length <= 2)
        return { chatId, stamp: chat.shell_stamp, userStamp, forks: JSON.stringify(forks) }
      }).pipe(query("StImportChatSummaries"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
