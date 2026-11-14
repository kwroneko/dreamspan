// The re-import preview (ARCHITECTURE.md §13 "Re-import preview"): before an ST folder import
// writes anything, a dry run over the folder's chat files that already have chats here, by
// the import's own parts: the same format worker parse (`Formats.st.chatPart`), the same
// mapping of a file to its chat (`stChatTarget`), and per batch the writer's matcher run in a
// reader worker with writes that only count (`StImportPlanBatch`). Nothing is written.
//
// A preview is held in memory, one per user, until an hour after it was last read or the
// user's next. A folder named by its path is read here, part by part, in a fiber the user can
// cancel; a folder picked in a browser sends the files the preview asks for over HTTP
// (`POST /st-import/plan-file`), part by part, as an import does. Memory stays bounded: one
// part (at most 8 MiB) at a time, and at most `PLAN_MESSAGES_HELD` changed messages per file,
// `MAX_HELD` in all.
//
// The import writes a folder's files one after another, so a later file sees what earlier
// ones wrote to its chat (a branch file, the messages its parent file adds). For a chat more
// than one file goes into, the preview keeps what the earlier files would write
// (`PlaceOverlay`) and passes it to each batch, so the later file matches it too.
//
// The stamp of the chats it reads (`StImportPlanStamp`) is taken before the first file is
// read. The import the user confirms passes it to `StImportBegin`, which takes it again in
// its transaction and refuses to start if anything changed since: the plan shown is never
// silently replaced by a different write.
import type { ChatId } from "@rp/shared/chat.ts"
import type { User } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { classifyStPath, stParentPath } from "@rp/shared/stFolder.ts"
import type { StFolderEntry } from "@rp/shared/stImportApi.ts"
import { orderStBranches, stPlan } from "@rp/shared/stPlan.ts"
import {
  emptyPlanCounts,
  PLAN_MESSAGES_HELD,
  PLAN_MESSAGES_PAGE,
  type StPlanCounts,
  StImportPlan,
  StImportPlanChanged,
  StPlanFile,
  type StPlanMessage,
  type StPlanTarget
} from "@rp/shared/stReimportPlan.ts"
import { Context, Effect, Fiber, Layer } from "effect"
import { Reader } from "../db/Database.ts"
import type { OverlaySlot, OverlayVersion, PlaceOverlay } from "../db/stImportPlace.ts"
import { sourceTime } from "../formats/sourceTime.ts"
import { Formats } from "./Formats.ts"
import { stChatTarget, type StChatRecordView } from "./stChatTarget.ts"
import { readStFolderFile } from "./stFolderDisk.ts"
import type { StPlanExpect } from "./StImports.ts"

/** A preview not read for this long is forgotten. */
const IDLE_MS = 60 * 60 * 1000
/** Changed messages held across a preview's files. */
const MAX_HELD = 20_000

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

interface FileState {
  readonly entry: StPlanEntry
  readonly target: StPlanTarget
  readonly recordId: string
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
}

/** What the files before would write to a chat that more than one file goes into. */
interface Overlay {
  readonly slots: Array<OverlaySlot>
  readonly versions: Array<{ readonly slotId: string; readonly version: OverlayVersion }>
  readonly selects: Array<{ readonly slotId: string; readonly versionId: string }>
  json: string | null
}

interface Plan {
  readonly id: string
  readonly user: User
  readonly mode: "path" | "upload"
  readonly root: string | null
  readonly files: ReadonlyArray<FileState>
  readonly byPath: ReadonlyMap<string, FileState>
  readonly newChats: number
  readonly bytesTotal: number
  readonly chatIds: ReadonlyArray<string>
  readonly stamp: string
  /**
   * By chat, for a chat more than one of the files goes into: what the files before would
   * write to it, which a later file's dry run matches as the import would (`PlaceOverlay`).
   */
  readonly overlays: ReadonlyMap<string, Overlay>
  batches: number
  status: StImportPlan["status"]
  filesDone: number
  bytesDone: number
  currentFile: string | null
  error: string | null
  held: number
  touched: number
  fiber: Fiber.Fiber<unknown, unknown> | null
}

const counting = () => ({ ...emptyPlanCounts })

export class StImportPlans extends Context.Service<
  StImportPlans,
  {
    /**
     * Works out a new preview for the user, ending their earlier one: for a folder at `root`
     * (`mode: path`) it reads the files itself; for a browser's (`upload`), `wanted` names the
     * files it needs sent, in order.
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
     * The finished preview the user confirmed: what `StImportBegin` checks. For a folder read
     * by its path, `entries` are its chat files as read now: a file changed, added or gone
     * since the preview makes it out of date.
     */
    readonly confirm: (
      user: User,
      planId: string,
      entries: ReadonlyArray<StPlanEntry> | null
    ) => Effect.Effect<StPlanExpect, StImportPlanChanged>
  }
>()("rp/importer/StImportPlans") {
  static readonly layer = Layer.effect(
    StImportPlans,
    Effect.gen(function* () {
      const reader = yield* Reader
      const formats = yield* Formats
      const plans = new Map<string, Plan>()

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
          filesTotal: plan.files.length,
          filesDone: plan.filesDone,
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

      /** A file is done: its counts stand; the preview is done with its last. */
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
        plan.filesDone++
        if (plan.filesDone === plan.files.length && plan.status === "running") {
          plan.status = "done"
          plan.currentFile = null
        }
      }

      /** One part of a file through the dry run: parse, then each batch through the matcher. */
      const part = (plan: Plan, file: FileState, bytes: Uint8Array, index: number, last: boolean) =>
        Effect.gen(function* () {
          if (index === 0) {
            Object.assign(file, {
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
            if (overlay !== undefined && pending > 0 && overlay.json === null)
              overlay.json = JSON.stringify({
                slots: overlay.slots,
                versions: overlay.versions,
                selects: overlay.selects
              })
            const planned = yield* reader.StImportPlanBatch({
              userId: plan.user.id,
              recordId: file.recordId,
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
              track: overlay !== undefined
            })
            if (overlay !== undefined && planned.written !== null) {
              const written = JSON.parse(planned.written) as PlaceOverlay
              overlay.slots.push(...written.slots)
              overlay.versions.push(...written.versions)
              overlay.selects.push(...written.selects)
              overlay.json = null
            }
            file.chatId = planned.chatId
            file.chatTitle = planned.chatTitle
            file.cursor = planned.cursor === null ? null : { id: planned.cursor.id, depth: planned.cursor.depth }
            file.matching = planned.matching
            file.carry = planned.carry
            file.keepsTip = planned.carry.keepTip
            for (const key of Object.keys(planned.counts) as Array<keyof StPlanCounts>)
              file.counts[key] += planned.counts[key]
            file.messages.push(...planned.messages)
            plan.held += planned.messages.length
            file.moreMessages += planned.changed - planned.messages.length
            file.index += planned.counts.unchanged + planned.changed
          }
          file.nextPart = index + 1
          if (last) {
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
          })
        )

      /** A folder read by its path: each file part by part, in the import's order. */
      const runPath = (plan: Plan, root: string) =>
        Effect.gen(function* () {
          let base = 0
          for (const file of plan.files) {
            if (plan.status !== "running") return
            if (file.status !== "waiting") continue
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
                break
              }
              start = read.success.next
              plan.bytesDone = base + Math.min(start, file.entry.size)
              const outcome = yield* part(plan, file, read.success.bytes, index, read.success.last)
              if (outcome !== "continue") break
            }
            base += file.entry.size
            plan.bytesDone = base
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("an ST re-import preview failed", cause).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  plan.status = "failed"
                  plan.error = "The check failed on the server. Try again."
                })
              )
            )
          )
        )

      /** Which of the folder's chat files go into chats here, as the import maps them. */
      const mapped = (
        records: ReadonlyMap<string, StChatRecordView & { readonly forkId: string }>,
        entries: ReadonlyArray<StPlanEntry>
      ) => {
        const files: Array<FileState> = []
        let newChats = 0
        for (const entry of entries) {
          const kind = classifyStPath(entry.path)
          if (kind === null || (kind.kind !== "chat" && kind.kind !== "group_chat")) continue
          const parentPath = entry.mainChat === null ? null : stParentPath(kind, entry.mainChat)
          // A branch whose parent isn't here yet is planned as the import ends up taking it:
          // with its parent's chat if the parent is in this folder and new, a new chat too.
          const target = stChatTarget(records, entry.path, parentPath, true)
          const base = {
            entry,
            parentPath,
            chatTitle: "",
            status: "waiting" as const,
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
            overlayMark: null
          }
          if (target._tag === "bin") {
            files.push({
              ...base,
              target: "bin",
              recordId: target.own.recordId,
              branch: false,
              strict: false,
              chatId: target.own.chatId as ChatId,
              status: "done"
            })
          } else if (target._tag === "chat" && target.own !== undefined) {
            files.push({
              ...base,
              target: target.own.complete ? "existing" : "unfinished",
              recordId: target.own.recordId,
              branch: false,
              strict: target.branch,
              chatId: target.own.chatId as ChatId
            })
          } else if (target._tag === "chat" && target.into !== undefined) {
            files.push({
              ...base,
              target: "branch",
              recordId: target.into.recordId,
              branch: true,
              strict: true,
              chatId: target.into.chatId as ChatId
            })
          } else newChats++
        }
        return { files, newChats }
      }

      const recordsOf = (user: User) =>
        Effect.map(
          reader.StImportSources({ userId: user.id }),
          (sources) => new Map(sources.chats.map((record) => [record.source, record]))
        )

      const end = (user: User) => {
        const old = plans.get(user.id)
        plans.delete(user.id)
        if (old !== undefined) old.status = old.status === "running" ? "cancelled" : old.status
        return old?.fiber == null ? Effect.void : Fiber.interrupt(old.fiber)
      }

      const start = (
        user: User,
        input: { readonly mode: "path"; readonly root: string } | { readonly mode: "upload" },
        entries: ReadonlyArray<StPlanEntry>
      ) =>
        Effect.gen(function* () {
          yield* end(user)
          const { files, newChats } = mapped(yield* recordsOf(user), entries)
          const chatIds = [...new Set(files.map((file) => file.chatId))]
          const sharing = new Map<string, number>()
          for (const file of files)
            if (file.status === "waiting") sharing.set(file.chatId, (sharing.get(file.chatId) ?? 0) + 1)
          // Before any file is read: a change after this makes the confirmed import refuse.
          const stamp = yield* reader.StImportPlanStamp({ userId: user.id, chatIds })
          const plan: Plan = {
            id: uuidv7(),
            user,
            mode: input.mode,
            root: input.mode === "path" ? input.root : null,
            files,
            byPath: new Map(files.map((file) => [file.entry.path, file])),
            newChats,
            bytesTotal: files.reduce((sum, file) => sum + (file.status === "waiting" ? file.entry.size : 0), 0),
            chatIds,
            stamp,
            overlays: new Map(
              [...sharing].flatMap(([chatId, n]) =>
                n > 1 ? [[chatId, { slots: [], versions: [], selects: [], json: null } as Overlay] as const] : []
              )
            ),
            batches: 0,
            status: "running",
            filesDone: files.filter((file) => file.status === "done").length,
            bytesDone: 0,
            currentFile: null,
            error: null,
            held: 0,
            touched: Date.now(),
            fiber: null
          }
          if (plan.filesDone === files.length) plan.status = "done"
          plans.set(user.id, plan)
          if (input.mode === "path" && plan.status === "running")
            plan.fiber = yield* Effect.forkDetach(runPath(plan, input.root))
          return {
            plan: snapshot(plan),
            wanted: input.mode === "upload" ? files.filter((f) => f.status === "waiting").map((f) => f.entry.path) : []
          }
        })

      return StImportPlans.of({
        start,
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
            const file = plan.byPath.get(path)
            if (plan.mode !== "upload" || plan.status !== "running" || file === undefined)
              return yield* new NotFound({ entity: "import preview file", id: path })
            if (file.status === "done" || file.status === "failed") return "done" as const
            const outcome = yield* part(plan, file, bytes, index, last)
            plan.bytesDone += bytes.byteLength
            return outcome
          }),
        confirm: (user, planId, entries) =>
          Effect.gen(function* () {
            const changed = (message: string) => new StImportPlanChanged({ message })
            const plan = plans.get(user.id)
            if (plan === undefined || plan.id !== planId || plan.status !== "done")
              return yield* changed("This check isn't finished or has expired. Check the folder again, then import.")
            if (entries !== null) {
              // The folder as read now must map to the same files, unchanged.
              const now = mapped(yield* recordsOf(user).pipe(Effect.orDie), entries).files
              const same =
                now.length === plan.files.length &&
                now.every((file) => {
                  const was = plan.byPath.get(file.entry.path)
                  return (
                    was !== undefined &&
                    was.entry.size === file.entry.size &&
                    was.entry.modifiedMs === file.entry.modifiedMs
                  )
                })
              if (!same) {
                yield* end(user)
                return yield* changed(
                  "The folder changed since this check, so it was worked out again. Look it over, then import."
                )
              }
            }
            return { chatIds: plan.chatIds, stamp: plan.stamp }
          })
      })
    })
  )
}
