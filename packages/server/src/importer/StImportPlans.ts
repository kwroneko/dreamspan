// The re-import preview (ARCHITECTURE.md §13 "Re-import preview"): before an ST folder import
// writes anything, a dry run over the folder's chat files that go into chats already here, by
// the import's own parts: the same format worker parse (`Formats.st.chatPart`), the same
// rounds and mapping of a file to its chat (`stSendRounds`, `stChatTarget`), and per batch the
// writer's matcher run in a reader worker with writes that only count (`StImportPlanBatch`).
// Nothing is written.
//
// A preview is held in memory, one per user, until an hour after it was last read or the
// user's next. A folder named by its path is read here, part by part, in a fiber the user can
// cancel; a folder picked in a browser sends the files the preview asks for over HTTP
// (`POST /st-import/plan-file`), part by part and in the order asked, as an import does.
// Memory stays bounded: one part (at most 8 MiB) at a time, and at most `PLAN_MESSAGES_HELD`
// changed messages per file, `MAX_HELD` in all.
//
// Files are mapped as the import maps them, one after another: a branch file whose parent is
// a new branch of a chat here goes into that chat too, once its parent would have a record
// (`RouteRecord`, made for the parent as the import's `StImportStartChat` would). For a chat
// more than one file goes into, the preview keeps what the earlier files would write
// (`PlaceOverlay`) and passes it to each batch, so the later file matches it too.
//
// Each chat's stamp (`StImportPlanStamp`) is read before the first file is mapped, and again
// once the last is read: a chat that changed in between fails the check. The import the user
// confirms is held to it file by file (`StImports`, `StImportCommitChat`): a file whose chat
// moved off its stamp, or whose bytes aren't the ones read here (`stBytesHash`), isn't
// imported, and the report says so.
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { User } from "@dreamspan/shared/domain.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { classifyStPath, stParentPath } from "@dreamspan/shared/stFolder.ts"
import type { StFolderEntry } from "@dreamspan/shared/stImportApi.ts"
import { orderStBranches, stPlan, stSendRounds } from "@dreamspan/shared/stPlan.ts"
import {
  emptyPlanCounts,
  PLAN_MESSAGES_HELD,
  PLAN_MESSAGES_PAGE,
  type StPlanCounts,
  StImportPlan,
  StImportPlanChanged,
  stPlanAffectedBySkip,
  StPlanFile,
  type StPlanMessage,
  type StPlanTarget
} from "@dreamspan/shared/stReimportPlan.ts"
import { Context, Effect, Fiber, Layer, Schedule, Semaphore } from "effect"
import { Reader } from "../db/Database.ts"
import type { OverlaySlot, OverlayVersion, PlaceOverlay } from "../db/stImportPlace.ts"
import { emptyDigest } from "../db/stImportPlanCount.ts"
import { sourceTime } from "../formats/sourceTime.ts"
import { Formats } from "./Formats.ts"
import { stChatTarget, type StChatRecordView } from "./stChatTarget.ts"
import { readStFolderFile } from "./stFolderDisk.ts"
import { stBytesHash, type StPlanExpect, type StPlanExpectFile } from "./stPlanExpect.ts"

/** A preview not read for this long is forgotten. */
const IDLE_MS = 60 * 60 * 1000
/** Changed messages held across a preview's files. */
const MAX_HELD = 20_000
/** Bound virtual writes as well as detail rows, across all shared chats. */
const MAX_OVERLAY_ITEMS = 50_000

/** A chat file of the folder, as the preview is given it. */
export interface StPlanEntry {
  readonly path: string
  readonly size: number
  /** When it last changed (stat for a path, `File.lastModified` for a browser's). */
  readonly modifiedMs: number | null
  /** The parent the file's header names, for a branch. */
  readonly mainChat: string | null
}

/**
 * What an import of the ST user `prefix` of a scanned folder reads, in order, and its chat
 * files for the preview: one list for the import (StImportJobs.startPath) and its preview.
 */
export const stFolderPlanFiles = (
  scanned: { readonly root: string; readonly files: ReadonlyArray<StFolderEntry> },
  prefix: string
) => {
  const plan = stPlan(scanned.files, prefix)
  // Read from the ST user's folder, where the plan's paths are.
  const root = prefix === "" ? scanned.root : `${scanned.root}/${prefix.slice(0, -1)}`
  const files = orderStBranches(plan.send, (entry) => entry.item.mainChat)
  const entries: ReadonlyArray<StPlanEntry> = files
    .filter((file) => file.kind === "chat" || file.kind === "group_chat")
    .map((file) => ({
      path: file.path,
      size: file.size,
      modifiedMs: file.item.modifiedMs,
      mainChat: file.item.mainChat
    }))
  return { plan, root, files, entries }
}

/**
 * A chat file's record as the import would have it by the time it reaches a file: the
 * records stored, and those its earlier files would make. A new branch of a chat here gets
 * one on a fork of its parent's (`StImportStartChat`), which the preview can't read: its
 * batches are read as its parent's real record's (`readAs`), seeing the selections of the
 * forks it inherits from (`lineage`, its own first).
 */
interface RouteRecord extends StChatRecordView {
  readonly forkId: string
  readonly readAs: string
  readonly lineage: ReadonlyArray<string>
}

interface FileState {
  readonly entry: StPlanEntry
  readonly target: StPlanTarget
  /** Its own record (existing, unfinished), or its parent's (a branch). */
  readonly recordId: string
  /** The stored record its batches are read as. */
  readonly readAs: string
  readonly forkId: string
  readonly lineage: ReadonlyArray<string>
  /** The record is the parent file's: the file is a new branch in its chat. */
  readonly branch: boolean
  /** Matched as a branch merged into another file's chat (`StImportMessages.strict`). */
  readonly strict: boolean
  readonly parentPath: string | null
  chatId: ChatId
  chatTitle: string
  status: StPlanFile["status"]
  counts: { -readonly [K in keyof StPlanCounts]: number }
  keepsTip: boolean
  messages: Array<StPlanMessage>
  moreMessages: number
  error: string | null
  // How far the dry run got, across the file's parts.
  nextPart: number
  index: number
  userTurns: number
  lastAt: number | null
  cursor: { readonly id: string; readonly depth: number } | null
  matching: boolean
  carry: { readonly keepTip: boolean; readonly branchDeleted: boolean; readonly last: string | null } | null
  /** Its chat's overlay sizes before the file, to take back if it's read again. */
  overlayMark: readonly [number, number, number] | null
  content: ReturnType<typeof stBytesHash>
  digest: string
  sha256: string | null
}

/** What the files before would write to a chat that more than one file goes into. */
interface Overlay {
  readonly slots: Array<OverlaySlot>
  readonly versions: Array<{ readonly slotId: string; readonly version: OverlayVersion }>
  readonly selects: Array<{ readonly slotId: string; readonly versionId: string; readonly forkId: string }>
  jsonFork: string | null
  json: string | null
}

type Step = IteratorResult<{ readonly entry: StPlanEntry; readonly orphan: boolean }, void>

interface Plan {
  readonly id: string
  readonly user: User
  readonly mode: "path" | "upload"
  readonly root: string | null
  readonly entries: ReadonlyArray<StPlanEntry>
  /** The files that go into chats here, as they're mapped. */
  readonly files: Array<FileState>
  readonly byPath: Map<string, FileState>
  /** Where each file went when last mapped: read here, or not (new, in the bin, deferred for good). */
  readonly routed: Map<string, "read" | "other">
  /** Each chat's stamp before the first file was mapped. */
  readonly stamps: Readonly<Record<string, string>>
  readonly records: Map<string, RouteRecord>
  readonly rounds: Generator<{ readonly entry: StPlanEntry; readonly orphan: boolean }, void, boolean | undefined>
  step: Step
  /** The file being read, whose route waits on it. */
  reading: FileState | null
  newChats: number
  /** The files expected to be read, as mapped before any was: the total until all are. */
  expected: number
  bytesTotal: number
  /**
   * By chat, for a chat more than one of the files may go into: what the files before would
   * write to it, which a later file's dry run matches as the import would (`PlaceOverlay`).
   */
  readonly overlays: Map<string, Overlay>
  overlayItems: number
  batches: number
  status: StImportPlan["status"]
  bytesDone: number
  currentFile: string | null
  error: string | null
  held: number
  touched: number
  fiber: Fiber.Fiber<unknown, unknown> | null
}

const counting = () => ({ ...emptyPlanCounts })

const chatPath = (entry: StPlanEntry) => {
  const kind = classifyStPath(entry.path)
  if (kind === null || (kind.kind !== "chat" && kind.kind !== "group_chat")) return null
  return { parentPath: entry.mainChat === null ? null : stParentPath(kind, entry.mainChat) }
}

/** A record of a file the import would make, going into `chatId`. */
const madeRecord = (path: string, chatId: string, merged: boolean, from: RouteRecord | null, forkId: string) => ({
  recordId: `virtual:${path}`,
  chatId,
  complete: false,
  binned: false,
  merged,
  forkId,
  readAs: from?.readAs ?? "",
  lineage: from === null ? [] : [forkId, ...from.lineage]
})

/**
 * Where the rounds take each file: read (a chat here), or not. `outcome` says whether a file
 * read makes or keeps a record, which its branches' mapping turns on.
 */
const route = (
  records: Map<string, RouteRecord>,
  stamps: Readonly<Record<string, string>>,
  step: { readonly entry: StPlanEntry; readonly orphan: boolean }
) => {
  const path = chatPath(step.entry)
  if (path === null) return { _tag: "other" as const }
  const target = stChatTarget(records, step.entry.path, path.parentPath, step.orphan)
  if (target._tag === "deferred") return { _tag: "deferred" as const }
  if (target._tag === "bin") return { _tag: "bin" as const, own: target.own, parentPath: path.parentPath }
  if (target.own !== undefined && stamps[target.own.chatId] !== undefined)
    return { _tag: "own" as const, own: target.own, branch: target.branch, parentPath: path.parentPath }
  if (target.into !== undefined && stamps[target.into.chatId] !== undefined)
    return { _tag: "into" as const, into: target.into, parentPath: path.parentPath }
  return { _tag: "new" as const, into: target.into }
}

export class StImportPlans extends Context.Service<
  StImportPlans,
  {
    /**
     * Works out a new preview for the user, ending their earlier one: for a folder at `root`
     * (`mode: path`) it reads the files itself; for a browser's (`upload`), `wanted` names the
     * files it needs sent, in the order to send them.
     */
    readonly start: (
      user: User,
      input: { readonly mode: "path"; readonly root: string } | { readonly mode: "upload" },
      entries: ReadonlyArray<StPlanEntry>
    ) => Effect.Effect<{ readonly plan: StImportPlan; readonly wanted: ReadonlyArray<string> }, unknown>
    readonly get: (user: User, planId: string) => Effect.Effect<StImportPlan, NotFound>
    readonly messages: (
      user: User,
      planId: string,
      path: string,
      offset: number
    ) => Effect.Effect<{ readonly messages: ReadonlyArray<StPlanMessage>; readonly total: number }, NotFound>
    readonly cancel: (user: User, planId: string) => Effect.Effect<void, NotFound>
    readonly exists: (user: User, planId: string) => boolean
    /** One part of a browser's file the preview asked for: `continue`, `done`, or `restart` from its start. */
    readonly file: (
      user: User,
      planId: string,
      path: string,
      bytes: Uint8Array,
      part: number,
      last: boolean
    ) => Effect.Effect<"continue" | "done" | "restart", NotFound>
    /**
     * The finished preview the user confirmed, with the files they skip: what the import is
     * held to (`StPlanExpect`). For a folder read by its path, `entries` are its chat files as
     * read now: a file added, gone or changed in size or date since makes it out of date.
     */
    readonly confirm: (
      user: User,
      planId: string,
      entries: ReadonlyArray<StPlanEntry> | null,
      root: string | null,
      skip: ReadonlyArray<string>
    ) => Effect.Effect<StPlanExpect, StImportPlanChanged>
  }
>()("rp/importer/StImportPlans") {
  static readonly layer = Layer.effect(
    StImportPlans,
    Effect.gen(function* () {
      const reader = yield* Reader
      const formats = yield* Formats
      const plans = new Map<string, Plan>()
      const starting = yield* Semaphore.make(1)
      const scope = yield* Effect.scope

      const planOf = (user: User, planId: string) => {
        const plan = plans.get(user.id)
        if (plan === undefined || plan.id !== planId || Date.now() - plan.touched > IDLE_MS)
          return Effect.fail(new NotFound({ entity: "import preview", id: planId }))
        plan.touched = Date.now()
        return Effect.succeed(plan)
      }

      const snapshot = (plan: Plan) =>
        new StImportPlan({
          planId: plan.id,
          status: plan.status,
          filesTotal: Math.max(plan.files.length, plan.expected),
          filesDone: plan.files.filter((file) => file.status === "done" || file.status === "failed").length,
          bytesTotal: plan.bytesTotal,
          bytesDone: plan.bytesDone,
          currentFile: plan.currentFile,
          files: plan.files.map(
            (file) =>
              new StPlanFile({
                path: file.entry.path,
                target: file.target,
                chatId: file.chatId,
                chatTitle: file.chatTitle,
                parentPath: file.parentPath,
                status: file.status,
                counts: { ...file.counts },
                keepsTip: file.keepsTip,
                messages: file.messages.length,
                moreMessages: file.moreMessages,
                error: file.error
              })
          ),
          newChats: plan.newChats,
          error: plan.error
        })

      const fail = (plan: Plan, error: string) => {
        if (plan.status !== "running") return
        plan.status = "failed"
        plan.error = error
        plan.currentFile = null
        plan.overlays.clear()
      }

      /** A file is read: its counts stand, and the rounds go on past it. */
      const settle = (plan: Plan, file: FileState, status: "done" | "failed", error: string | null = null) => {
        if (file.status === "done" || file.status === "failed") return
        // A chat of one message, not the user's, or of none: the import skips it (DESIGN §1.4).
        if (status === "done" && (file.index === 0 || (file.index === 1 && file.userTurns === 0))) {
          file.counts = counting()
          plan.held -= file.messages.length
          file.messages = []
          file.moreMessages = 0
          ;(file as { target: StPlanTarget }).target = "greeting"
        }
        file.status = status
        file.error = error
        // A new branch the import takes gets its record from its first messages on.
        if (status === "done" && file.target === "branch") {
          const parent = plan.records.get(file.parentPath ?? "")
          if (parent !== undefined)
            plan.records.set(file.entry.path, {
              ...madeRecord(file.entry.path, file.chatId, true, parent, file.forkId),
              readAs: file.readAs
            })
        }
        if (plan.reading === file) {
          plan.reading = null
          plan.step = plan.rounds.next(false)
        }
      }

      /** Each chat's stamp again, once every file is read: a chat that moved fails the check. */
      const verify = (plan: Plan) =>
        Effect.gen(function* () {
          const now = yield* reader.StImportPlanStamp({ userId: plan.user.id })
          if (plan.status !== "running") return
          const moved = plan.files.some(
            (file) =>
              file.target !== "bin" && file.target !== "greeting" && now[file.chatId] !== plan.stamps[file.chatId]
          )
          plan.currentFile = null
          plan.expected = plan.files.length
          if (moved) return fail(plan, "Your chats changed while they were being checked. Check the folder again.")
          if (plan.files.some((entry) => entry.status === "failed"))
            return fail(plan, "Some chats could not be checked. Check the folder again before importing.")
          plan.status = "done"
          plan.overlays.clear()
        })

      /**
       * Takes the rounds on to the next file to read (`plan.reading`), mapping each file before
       * it as the import would; at their end, the check is done.
       */
      const drive = (plan: Plan) =>
        Effect.gen(function* () {
          while (plan.status === "running" && plan.reading === null) {
            const step = plan.step
            if (step.done) return yield* verify(plan)
            const { entry } = step.value
            const routed = route(plan.records, plan.stamps, step.value)
            if (routed._tag === "deferred") {
              plan.step = plan.rounds.next(true)
              continue
            }
            if (routed._tag === "other" || routed._tag === "new" || routed._tag === "bin") {
              plan.routed.set(entry.path, "other")
              if (routed._tag === "new") {
                if (routed.into === undefined) plan.newChats++
                // What the import makes of it, which a branch of it goes into.
                plan.records.set(
                  entry.path,
                  madeRecord(
                    entry.path,
                    routed.into?.chatId ?? `new:${entry.path}`,
                    routed.into !== undefined,
                    null,
                    ""
                  )
                )
              }
              if (routed._tag === "bin" && !plan.byPath.has(entry.path)) {
                const file = fileState(plan, entry, routed.parentPath, {
                  target: "bin",
                  recordId: routed.own.recordId,
                  readAs: routed.own.readAs,
                  forkId: routed.own.forkId,
                  lineage: routed.own.lineage,
                  branch: false,
                  strict: false,
                  chatId: routed.own.chatId as ChatId
                })
                file.status = "done"
              }
              plan.step = plan.rounds.next(false)
              continue
            }
            plan.routed.set(entry.path, "read")
            const previous = plan.byPath.get(entry.path)
            if (previous !== undefined) {
              // Read already (a branch sent again on its own maps as it did).
              plan.step = plan.rounds.next(false)
              continue
            }
            plan.reading =
              routed._tag === "own"
                ? fileState(plan, entry, routed.parentPath, {
                    target: routed.own.complete ? "existing" : "unfinished",
                    recordId: routed.own.recordId,
                    readAs: routed.own.readAs,
                    forkId: routed.own.forkId,
                    lineage: routed.own.lineage,
                    branch: false,
                    strict: routed.branch,
                    chatId: routed.own.chatId as ChatId
                  })
                : fileState(plan, entry, routed.parentPath, {
                    target: "branch",
                    recordId: routed.into.recordId,
                    readAs: routed.into.readAs,
                    forkId: `preview-fork:${entry.path}`,
                    lineage: [`preview-fork:${entry.path}`, ...routed.into.lineage],
                    branch: true,
                    strict: true,
                    chatId: routed.into.chatId as ChatId
                  })
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("an ST re-import preview failed", cause).pipe(
              Effect.andThen(Effect.sync(() => fail(plan, "The check failed on the server. Try again.")))
            )
          )
        )

      const fileState = (
        plan: Plan,
        entry: StPlanEntry,
        parentPath: string | null,
        mapped: Pick<
          FileState,
          "target" | "recordId" | "readAs" | "forkId" | "lineage" | "branch" | "strict" | "chatId"
        >
      ) => {
        const file: FileState = {
          entry,
          parentPath,
          ...mapped,
          chatTitle: "",
          status: "waiting",
          counts: counting(),
          keepsTip: false,
          messages: [],
          moreMessages: 0,
          error: null,
          nextPart: 0,
          index: 0,
          userTurns: 0,
          lastAt: null,
          cursor: null,
          matching: true,
          carry: null,
          overlayMark: null,
          content: stBytesHash(),
          digest: emptyDigest,
          sha256: null
        }
        plan.files.push(file)
        plan.byPath.set(entry.path, file)
        return file
      }

      /** One part of a file through the dry run: parse, then each batch through the matcher. */
      const part = (plan: Plan, file: FileState, bytes: Uint8Array, index: number, last: boolean) =>
        Effect.gen(function* () {
          if (index === 0) {
            Object.assign(file, {
              content: stBytesHash(),
              digest: emptyDigest,
              sha256: null,
              nextPart: 0,
              index: 0,
              userTurns: 0,
              lastAt: null,
              cursor: null,
              matching: true,
              carry: null,
              counts: counting(),
              keepsTip: false,
              moreMessages: 0
            })
            plan.held -= file.messages.length
            file.messages = []
            // A file read again from its start takes back what it added to its chat's overlay.
            const overlay = plan.overlays.get(file.chatId)
            if (overlay !== undefined) {
              if (file.overlayMark === null)
                file.overlayMark = [overlay.slots.length, overlay.versions.length, overlay.selects.length]
              else {
                overlay.slots.length = file.overlayMark[0]
                overlay.versions.length = file.overlayMark[1]
                overlay.selects.length = file.overlayMark[2]
                overlay.json = null
              }
            }
          } else if (file.nextPart !== index) return "restart" as const
          file.status = "checking"
          plan.currentFile = file.entry.path
          // Hashed as the import hashes the bytes it takes (`stBytesHash`), before the parse
          // takes them.
          file.content.update(bytes)
          const parsed = yield* formats.st.chatPart({
            bytes,
            first: index === 0,
            firstIndex: file.index,
            carryAt: file.lastAt,
            // As the import dates a message without a date (StImports.file).
            fallbackAt: sourceTime(file.entry.modifiedMs) ?? Date.now()
          })
          const error = parsed.report.issues.find((issue) => issue.level === "error")
          if (error !== undefined) {
            settle(plan, file, "failed", error.message)
            return "done" as const
          }
          file.userTurns += parsed.userTurns
          file.lastAt = parsed.lastAt
          for (const batch of parsed.batches) {
            const overlay = plan.overlays.get(file.chatId)
            const pending =
              overlay === undefined ? 0 : overlay.slots.length + overlay.versions.length + overlay.selects.length
            if (overlay !== undefined && pending > 0 && (overlay.json === null || overlay.jsonFork !== file.forkId)) {
              overlay.jsonFork = file.forkId
              overlay.json = JSON.stringify({
                slots: overlay.slots,
                versions: overlay.versions,
                // The selections of the forks the file's own inherits, as the import would.
                selects: overlay.selects.filter((selection) => file.lineage.includes(selection.forkId))
              })
            }
            const planned = yield* reader.StImportPlanBatch({
              userId: plan.user.id,
              recordId: file.readAs,
              branch: file.branch,
              parent: file.cursor,
              matching: file.matching,
              strict: file.strict,
              carry: file.carry,
              messagesJson: batch.messagesJson,
              firstIndex: file.index,
              detailLimit: Math.max(0, Math.min(PLAN_MESSAGES_HELD - file.messages.length, MAX_HELD - plan.held)),
              overlayJson: overlay === undefined || pending === 0 ? null : overlay.json,
              virtualPrefix: `virtual:${plan.batches++}:`,
              track: overlay !== undefined,
              digest: file.digest
            })
            if (overlay !== undefined && planned.written !== null) {
              const written = JSON.parse(planned.written) as PlaceOverlay
              plan.overlayItems +=
                written.slots.reduce((n, slot) => n + 1 + slot.versions.length, 0) +
                written.versions.length +
                written.selects.length
              if (plan.overlayItems > MAX_OVERLAY_ITEMS) {
                fail(plan, "These chats have too many shared changes to check together. Check a smaller folder.")
                return "done" as const
              }
              overlay.slots.push(...written.slots)
              overlay.versions.push(...written.versions)
              overlay.selects.push(...written.selects.map((selection) => ({ ...selection, forkId: file.forkId })))
              overlay.json = null
            }
            file.chatId = planned.chatId
            file.chatTitle = planned.chatTitle
            file.cursor = planned.cursor === null ? null : { id: planned.cursor.id, depth: planned.cursor.depth }
            file.matching = planned.matching
            file.carry = planned.carry
            file.keepsTip = planned.carry.keepTip
            file.digest = planned.digest
            for (const key of Object.keys(planned.counts) as Array<keyof StPlanCounts>)
              file.counts[key] += planned.counts[key]
            file.messages.push(...planned.messages)
            plan.held += planned.messages.length
            file.moreMessages += planned.changed - planned.messages.length
            file.index += planned.counts.unchanged + planned.changed
          }
          file.nextPart = index + 1
          if (last) {
            file.sha256 = file.content.digest("hex")
            settle(plan, file, "done")
            return "done" as const
          }
          return "continue" as const
        }).pipe(
          Effect.catch((error) => {
            const tag = (error as { readonly _tag?: string })._tag
            const message =
              tag === "NotFound" ? "This chat changed while it was being checked." : "This chat couldn't be checked."
            if (tag !== "NotFound")
              return Effect.logWarning("an ST re-import preview failed", error).pipe(
                Effect.andThen(Effect.sync(() => settle(plan, file, "failed", message))),
                Effect.as("done" as const)
              )
            return Effect.sync(() => settle(plan, file, "failed", message)).pipe(Effect.as("done" as const))
          }),
          Effect.tap(() => (plan.reading === null ? drive(plan) : Effect.void))
        )

      /** A folder read by its path: each file part by part, in the import's order. */
      const runPath = (plan: Plan, root: string) =>
        Effect.gen(function* () {
          yield* drive(plan)
          while (plan.status === "running" && plan.reading !== null) {
            const file = plan.reading
            let start = 0
            for (let index = 0; ; index++) {
              const read = yield* readStFolderFile(
                root,
                file.entry.path,
                { size: file.entry.size, modifiedMs: file.entry.modifiedMs ?? 0 },
                start,
                true
              ).pipe(Effect.result)
              if (read._tag === "Failure") {
                settle(plan, file, "failed", read.failure.message)
                yield* drive(plan)
                break
              }
              start = read.success.next
              plan.bytesDone += read.success.bytes.byteLength
              const outcome = yield* part(plan, file, read.success.bytes, index, read.success.last)
              if (outcome !== "continue") break
            }
          }
        }).pipe(
          Effect.catchCause((cause) =>
            plan.status !== "running"
              ? Effect.void
              : Effect.logError("an ST re-import preview failed", cause).pipe(
                  Effect.andThen(Effect.sync(() => fail(plan, "The check failed on the server. Try again.")))
                )
          )
        )

      const recordsOf = (user: User) =>
        Effect.map(
          reader.StImportSources({ userId: user.id }),
          (sources) =>
            new Map<string, RouteRecord>(
              sources.chats.map((record) => [
                record.source,
                { ...record, readAs: record.recordId, lineage: [record.forkId] }
              ])
            )
        )

      const end = (user: User) => {
        const old = plans.get(user.id)
        plans.delete(user.id)
        if (old !== undefined) old.status = old.status === "running" ? "cancelled" : old.status
        return old?.fiber == null ? Effect.void : Fiber.interrupt(old.fiber)
      }

      /**
       * The files the rounds would read, in order, if every file read makes its record: what a
       * browser is asked to send, and the chats more than one of them goes into.
       */
      const foresee = (
        records: ReadonlyMap<string, RouteRecord>,
        stamps: Readonly<Record<string, string>>,
        entries: ReadonlyArray<StPlanEntry>
      ) => {
        const ahead = new Map(records)
        const read: Array<StPlanEntry> = []
        const chats = new Map<string, number>()
        const rounds = stSendRounds(entries)
        for (let step = rounds.next(); !step.done;) {
          const { entry } = step.value
          const routed = route(ahead, stamps, step.value)
          if (routed._tag === "deferred") {
            step = rounds.next(true)
            continue
          }
          if (routed._tag === "new")
            ahead.set(
              entry.path,
              madeRecord(entry.path, routed.into?.chatId ?? `new:${entry.path}`, routed.into !== undefined, null, "")
            )
          if ((routed._tag === "own" || routed._tag === "into") && !read.includes(entry)) {
            read.push(entry)
            const chatId = routed._tag === "own" ? routed.own.chatId : routed.into.chatId
            chats.set(chatId, (chats.get(chatId) ?? 0) + 1)
            if (routed._tag === "into")
              ahead.set(entry.path, {
                ...madeRecord(entry.path, chatId, true, routed.into, `preview-fork:${entry.path}`),
                readAs: routed.into.readAs
              })
          }
          step = rounds.next(false)
        }
        return { read, shared: [...chats].filter(([, n]) => n > 1).map(([chatId]) => chatId) }
      }

      const start = (
        user: User,
        input: { readonly mode: "path"; readonly root: string } | { readonly mode: "upload" },
        entries: ReadonlyArray<StPlanEntry>
      ) =>
        Effect.gen(function* () {
          yield* end(user)
          // Stamps before mapping: a change after this fails the check or the file's import.
          const stamps = yield* reader.StImportPlanStamp({ userId: user.id })
          const records = yield* recordsOf(user)
          const chats = entries.filter((entry) => chatPath(entry) !== null)
          const ahead = foresee(records, stamps, chats)
          const rounds = stSendRounds(chats)
          const plan: Plan = {
            id: uuidv7(),
            user,
            mode: input.mode,
            root: input.mode === "path" ? input.root : null,
            entries,
            files: [],
            byPath: new Map(),
            routed: new Map(),
            stamps,
            records,
            rounds,
            step: rounds.next(),
            reading: null,
            newChats: 0,
            expected: ahead.read.length,
            bytesTotal: ahead.read.reduce((sum, entry) => sum + entry.size, 0),
            overlays: new Map(
              ahead.shared.map(
                (chatId) =>
                  [chatId, { slots: [], versions: [], selects: [], json: null, jsonFork: null } as Overlay] as const
              )
            ),
            overlayItems: 0,
            batches: 0,
            status: "running",
            bytesDone: 0,
            currentFile: null,
            error: null,
            held: 0,
            touched: Date.now(),
            fiber: null
          }
          plans.set(user.id, plan)
          if (input.mode === "path") plan.fiber = yield* Effect.forkIn(runPath(plan, input.root), scope)
          else yield* drive(plan)
          return {
            plan: snapshot(plan),
            wanted: input.mode === "upload" ? ahead.read.map((entry) => entry.path) : []
          }
        })

      // Expiry releases inactive accounts too; a timestamp check alone retained every
      // account's plan and detached work until that account happened to start another.
      yield* Effect.forkScoped(
        Effect.repeat(
          Effect.gen(function* () {
            const now = Date.now()
            for (const plan of plans.values()) if (now - plan.touched > IDLE_MS) yield* end(plan.user)
          }),
          Schedule.spaced("1 minute")
        )
      )

      return StImportPlans.of({
        start: (user, input, entries) => starting.withPermits(1)(start(user, input, entries)),
        get: (user, planId) => Effect.map(planOf(user, planId), snapshot),
        messages: (user, planId, path, offset) =>
          Effect.flatMap(planOf(user, planId), (plan) => {
            const file = plan.byPath.get(path)
            if (file === undefined) return Effect.fail(new NotFound({ entity: "file", id: path }))
            return Effect.succeed({
              messages: file.messages.slice(offset, offset + PLAN_MESSAGES_PAGE),
              total: file.messages.length
            })
          }),
        cancel: (user, planId) =>
          Effect.flatMap(planOf(user, planId), (plan) =>
            Effect.suspend(() => {
              if (plan.status !== "running") return Effect.void
              plan.status = "cancelled"
              plan.currentFile = null
              plan.overlays.clear()
              return plan.fiber === null ? Effect.void : Fiber.interrupt(plan.fiber)
            })
          ),
        exists: (user, planId) => {
          const plan = plans.get(user.id)
          return plan !== undefined && plan.id === planId && plan.mode === "upload" && plan.status === "running"
        },
        file: (user, planId, path, bytes, index, last) =>
          Effect.gen(function* () {
            const plan = yield* planOf(user, planId)
            if (plan.mode !== "upload" || plan.status !== "running")
              return yield* new NotFound({ entity: "import preview file", id: path })
            const file = plan.byPath.get(path)
            // Mapped elsewhere once the files before it were read (a parent that turned out
            // to hold only a greeting), or read already: nothing more of it is needed.
            if (
              file === undefined
                ? plan.routed.get(path) === "other"
                : file.status === "done" || file.status === "failed"
            )
              return "done" as const
            if (file === undefined || plan.reading !== file) {
              // Sent out of the order asked: the files before it weren't.
              if (plan.reading !== null) settle(plan, plan.reading, "failed", "It wasn't sent.")
              fail(plan, "The files weren't sent in the order asked. Check the folder again.")
              return "done" as const
            }
            const outcome = yield* part(plan, file, bytes, index, last)
            plan.bytesDone += bytes.byteLength
            return outcome
          }),
        confirm: (user, planId, entries, root, skip) =>
          Effect.gen(function* () {
            const changed = (message: string) => new StImportPlanChanged({ message })
            const plan = plans.get(user.id)
            if (
              plan === undefined ||
              plan.id !== planId ||
              plan.status !== "done" ||
              Date.now() - plan.touched > IDLE_MS
            )
              return yield* changed("This check isn't finished or has expired. Check the folder again, then import.")
            if (plan.root !== root || (plan.mode === "path") !== (entries !== null))
              return yield* changed("Choose the folder that was checked, then import.")
            if (entries !== null) {
              const same =
                entries.length === plan.entries.length &&
                entries.every((entry, index) => {
                  const was = plan.entries[index]
                  return (
                    was !== undefined &&
                    was.path === entry.path &&
                    was.size === entry.size &&
                    was.modifiedMs === entry.modifiedMs &&
                    was.mainChat === entry.mainChat
                  )
                })
              if (!same) return yield* changed("The folder changed since this check. Check it again before importing.")
            }
            // What each file read may do. Its bytes are checked as the import reads them, and
            // its chat in the transaction that writes it: no second read of the folder here.
            const skipped = new Set(skip)
            const affected = stPlanAffectedBySkip(
              plan.files.map((file) => ({ path: file.entry.path, chatId: file.chatId })),
              skipped
            )
            const files = new Map<string, StPlanExpectFile>()
            for (const file of plan.files) {
              if (file.status !== "done" || file.sha256 === null) continue
              // A file of a greeting only is held to its bytes too: the import skips it as well.
              if (file.target === "bin") continue
              files.set(file.entry.path, {
                path: file.entry.path,
                target: file.target,
                chatId: file.chatId,
                recordId: file.branch ? null : file.recordId,
                parentPath: file.parentPath,
                sha256: file.sha256,
                counts: { ...file.counts },
                digest: file.digest,
                keepsTip: file.keepsTip,
                uncertain: affected.has(file.entry.path)
              })
            }
            return {
              planId: plan.id,
              files,
              listed: new Map(plan.entries.map((entry) => [entry.path, entry.size])),
              stamps: new Map(Object.entries(plan.stamps)),
              skip: skipped
            } satisfies StPlanExpect
          })
      })
    })
  )
}
