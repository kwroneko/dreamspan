// ST folder imports as jobs the user can always see (ARCHITECTURE.md §13). A folder named by
// its path is imported here, on the server, in a fiber of this service's scope: the browser
// only starts it, and closing the tab, navigating or reloading never stops it. A folder sent
// from a browser is still driven by that browser, file by file; its job records the files
// as they arrive, and ends as interrupted when they stop arriving. Every job is a row of
// `st_import_jobs`: progress at most about once a second, the report when it ends, so the
// import page lists running and past imports after a reload and on other devices. A notice
// (StImportChanged) tells the user's tabs, at most about once a second per job.
//
// The import itself is StImports: this drives it as the client did (parts, `restart`,
// deferred branches again, then on their own), through the same `file` and its handlers.
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import type { User } from "@rp/shared/domain.ts"
import { NotFound, ServerError } from "@rp/shared/errors.ts"
import { classifyStPath, findStRoots } from "@rp/shared/stFolder.ts"
import {
  StCount,
  StFileResult,
  StFolderUnreadable,
  StImportBusy,
  StImportJob,
  StImportJobDetail,
  StImportedChat,
  StImportReport,
  type StImportStatus,
  StNotSent
} from "@rp/shared/stImportApi.ts"
import { orderStBranches, type StPlanned, stPlan } from "@rp/shared/stPlan.ts"
import type { StFolderEntry } from "@rp/shared/stImportApi.ts"
import { Cause, Context, Effect, Exit, Layer, Option, Schedule, Schema, Semaphore, type Types } from "effect"
import { Notices } from "../chat/Notices.ts"
import { Reader, Writer } from "../db/Database.ts"
import { readStFolderFile, scanStFolder, statStFolderFile } from "./stFolderDisk.ts"
import { StImports } from "./StImports.ts"

/** Progress is written, and the user's tabs told, at most this often per job. */
const PROGRESS_MS = 1_000
/** The report so far is written this often while a job runs, so an interrupted job keeps most of it. */
const REPORT_MS = 15_000
/** An upload whose files stop arriving for this long has ended: its tab was closed or lost. */
const UPLOAD_IDLE_MS = 10 * 60_000
const SWEEP_MS = 60_000
/** The "Not sent" list a job keeps. */
const MAX_NOT_SENT = 2_000

const ReportJson = Schema.fromJsonString(StImportReport)
const encodeReport = Schema.encodeSync(ReportJson)
const decodeReport = Schema.decodeUnknownSync(ReportJson)
const NotSentJson = Schema.fromJsonString(Schema.Array(StNotSent))
const decodeNotSent = Schema.decodeUnknownSync(NotSentJson)
const encodeNotSent = Schema.encodeSync(NotSentJson)

/**
 * What a report asks the user to act on, with the files that didn't go in: an issue on many
 * files counts once, as the report shows it once.
 */
const attentionOf = (report: StImportReport, notSent: number) =>
  new Set(report.issues.map((issue) => JSON.stringify([issue.level, issue.code, issue.message]))).size +
  report.links.length +
  report.hiddenRuns.length +
  notSent

/** A job running in this process. */
interface Live {
  readonly id: string
  readonly user: User
  readonly mode: "path" | "upload"
  filesTotal: number
  filesDone: number
  bytesTotal: number
  /** The bytes of the files done; `bytesDone` adds the file being read. */
  bytesBase: number
  bytesDone: number
  currentFile: string | null
  /** An upload's bytes of the file arriving. */
  currentBytes: number
  readonly notSent: Array<StNotSent>
  counts: string
  attention: number
  cancelled: boolean
  ended: boolean
  lastActivity: number
  lastWrite: number
  lastReport: number
}

type Extra = { readonly card: EntityId | "none" | null; readonly orphan: boolean }

export class StImportJobs extends Context.Service<
  StImportJobs,
  {
    /** Imports the ST user `prefix` of the folder at `path`, on the server; the job's id. */
    readonly startPath: (
      user: User,
      path: string,
      prefix: string
    ) => Effect.Effect<string, StFolderUnreadable | StImportBusy | ServerError>
    /** Starts an import a browser sends (StartStImport), with its job. */
    readonly startUpload: (
      user: User,
      unsupported: ReadonlyArray<string>,
      info: { readonly source: string; readonly files: number; readonly bytes: number }
    ) => Effect.Effect<string, StImportBusy | ServerError>
    /** A file, or a part of one, of an upload arrived and was taken: `failed` when the server failed it. */
    readonly arrived: (
      user: User,
      importId: string,
      path: string,
      bytes: number,
      outcome: StFileResult | { readonly failed: string }
    ) => Effect.Effect<void>
    readonly finishUpload: (
      user: User,
      importId: string,
      notSent: ReadonlyArray<StNotSent>
    ) => Effect.Effect<void, NotFound | ServerError>
    readonly list: (user: User) => Effect.Effect<ReadonlyArray<StImportJob>, ServerError>
    readonly get: (user: User, importId: string) => Effect.Effect<StImportJobDetail, NotFound | ServerError>
    readonly seen: (user: User, importId: string) => Effect.Effect<void, NotFound | ServerError>
    readonly cancel: (user: User, importId: string) => Effect.Effect<void, NotFound | ServerError>
    readonly clear: (user: User, importId: string | null) => Effect.Effect<number, ServerError>
    readonly link: (
      user: User,
      importId: string,
      path: string,
      card: EntityId | "none"
    ) => Effect.Effect<StFileResult, NotFound | StFolderUnreadable | StImportBusy | ServerError>
    /** A hidden run was un-hidden: the import whose report offered it stops offering it. */
    readonly unhidden: (user: User, importId: string, chatId: ChatId) => Effect.Effect<void>
  }
>()("rp/importer/StImportJobs") {
  static readonly layer = Layer.effect(
    StImportJobs,
    Effect.gen(function* () {
      const imports = yield* StImports
      const reader = yield* Reader
      const writer = yield* Writer
      const notices = yield* Notices
      const scope = yield* Effect.scope
      const lives = new Map<string, Live>()
      /** A path job's chats linked after its own run ended: the run that re-read the folder for them. */
      const helpers = new Map<string, string>()
      // Starting, and linking (which starts a run), one at a time: each fences the run before it.
      const starting = yield* Semaphore.make(1)

      /** Storage failing is the server's fault: logged, and said plainly. */
      const stored =
        (what: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.catch(effect, (error): Effect.Effect<never, E | ServerError> => {
            const tag = (error as { readonly _tag?: unknown } | null)?._tag
            return tag === "StorageError" || tag === "RpcClientError"
              ? Effect.logError(`${what} failed`, error).pipe(
                  Effect.andThen(Effect.fail(new ServerError({ message: `${what} failed; try again.` })))
                )
              : Effect.fail(error)
          }) as Effect.Effect<A, Types.ExcludeTag<E, "StorageError" | "RpcClientError"> | ServerError, R>

      // Whatever was running when the server stopped is over, with what it had.
      yield* writer
        .StImportJobsInterrupted({
          at: Date.now(),
          error: "The server stopped during this import. Import the folder again to go on from where it was."
        })
        .pipe(
          Effect.flatMap((count) =>
            count > 0
              ? Effect.logInfo(`${count} ST imports stopped with the server are marked interrupted`)
              : Effect.void
          ),
          Effect.catch((error) => Effect.logWarning("marking ST imports interrupted failed", error))
        )

      const publish = (live: { readonly user: User; readonly id: string }, status: StImportStatus) =>
        notices.publish(live.user.id, { _tag: "StImportChanged", importId: live.id, status })

      /** Writes the job's progress, with the report so far when `report`, and `end` if it ended. */
      const write = (
        live: Live,
        options: {
          readonly report: boolean
          readonly end?: { readonly status: Exclude<StImportStatus, "running">; readonly error: string | null }
        }
      ) =>
        Effect.gen(function* () {
          const report = yield* Effect.option(imports.report(live.user, live.id))
          if (Option.isSome(report)) {
            live.counts = JSON.stringify(report.value.counts)
            live.attention = attentionOf(report.value, live.notSent.length)
          }
          live.lastWrite = Date.now()
          yield* writer.StImportJobUpdate({
            userId: live.user.id,
            id: live.id,
            at: live.lastWrite,
            filesTotal: live.filesTotal,
            filesDone: live.filesDone,
            bytesTotal: live.bytesTotal,
            bytesDone: live.bytesDone,
            currentFile: live.currentFile,
            countsJson: live.counts,
            attention: live.attention,
            ...(options.report && Option.isSome(report) ? { reportJson: encodeReport(report.value) } : {}),
            notSentJson: encodeNotSent(live.notSent),
            ...(options.end === undefined ? {} : { end: options.end })
          })
        }).pipe(Effect.catch((error) => Effect.logWarning("saving an ST import's progress failed", error)))

      /** Progress, at most once a second: the row, and a notice to the user's tabs. */
      const tick = (live: Live) =>
        Effect.gen(function* () {
          const now = Date.now()
          if (now - live.lastWrite < PROGRESS_MS) return
          const report = now - live.lastReport >= REPORT_MS
          if (report) live.lastReport = now
          yield* write(live, { report })
          publish(live, "running")
        })

      const end = (live: Live, status: Exclude<StImportStatus, "running">, error: string | null) =>
        Effect.gen(function* () {
          if (live.ended) return
          live.ended = true
          lives.delete(live.id)
          live.currentFile = null
          yield* write(live, { report: true, end: { status, error } })
          publish(live, status)
        })

      const notSent = (live: Live, path: string, message: string) => {
        if (live.notSent.length < MAX_NOT_SENT) live.notSent.push(new StNotSent({ path, message }))
      }

      const runningPath = (user: User) =>
        [...lives.values()].find((live) => live.user.id === user.id && live.mode === "path")

      const busy = (user: User) =>
        Effect.gen(function* () {
          if (runningPath(user) !== undefined)
            return yield* new StImportBusy({
              message: "An import is running on the server. Wait until it's done, or cancel it, then try again."
            })
        })

      /** A new run fences the user's upload still running: it's over (StImportJobStart writes it so). */
      const supersede = (user: User) => {
        for (const live of lives.values()) {
          if (live.user.id !== user.id || live.mode !== "upload") continue
          live.ended = true
          lives.delete(live.id)
          publish(live, "interrupted")
        }
      }

      const begin = (
        user: User,
        importId: string,
        mode: "path" | "upload",
        source: string,
        root: string | null,
        prefix: string,
        files: number,
        bytes: number
      ) =>
        Effect.gen(function* () {
          const now = Date.now()
          const live: Live = {
            id: importId,
            user,
            mode,
            filesTotal: files,
            filesDone: 0,
            bytesTotal: bytes,
            bytesBase: 0,
            bytesDone: 0,
            currentFile: null,
            currentBytes: 0,
            notSent: [],
            counts: "{}",
            attention: 0,
            cancelled: false,
            ended: false,
            lastActivity: now,
            lastWrite: now,
            lastReport: now
          }
          supersede(user)
          yield* writer.StImportJobStart({
            userId: user.id,
            id: importId,
            mode,
            source,
            root,
            prefix,
            filesTotal: files,
            bytesTotal: bytes,
            at: now
          })
          lives.set(importId, live)
          publish(live, "running")
          return live
        })

      /**
       * One file of the folder at `root` through the import, a chat in parts of at most 8 MiB
       * cut at line ends, as the browser sends them; `onBytes` says how far into it.
       */
      const sendPathFile = (
        user: User,
        importId: string,
        root: string,
        entry: { readonly path: string; readonly size: number; readonly modifiedMs: number },
        extra: Extra,
        onBytes: (read: number) => Effect.Effect<void>
      ) =>
        Effect.gen(function* () {
          const kind = classifyStPath(entry.path)?.kind
          const chat = kind === "chat" || kind === "group_chat"
          let start = 0
          for (let part = 0; ; part++) {
            const read = yield* readStFolderFile(root, entry.path, entry, start, chat)
            const result = yield* imports.file(user, importId, entry.path, read.bytes, {
              part,
              last: read.last,
              card: extra.card,
              orphan: extra.orphan,
              createdAt: read.ctimeMs,
              modifiedAt: entry.modifiedMs
            })
            start = read.next
            yield* onBytes(start)
            if (result.outcome !== "continue") return result
            if (read.last)
              return new StFileResult({
                outcome: "failed",
                message: "The import wanted more of a chat that had ended."
              })
          }
        })

      /** Sends a file, and once more from its start if the server lost its earlier parts. */
      const sendWithRestart = (
        user: User,
        importId: string,
        root: string,
        entry: { readonly path: string; readonly size: number; readonly modifiedMs: number },
        extra: Extra,
        onBytes: (read: number) => Effect.Effect<void>
      ) =>
        Effect.flatMap(sendPathFile(user, importId, root, entry, extra, onBytes), (result) =>
          result.outcome === "restart"
            ? sendPathFile(user, importId, root, entry, extra, onBytes)
            : Effect.succeed(result)
        )

      /** The whole plan, in order: deferred branches again until none goes in, then on their own. */
      const runPath = (live: Live, root: string, files: ReadonlyArray<StPlanned<StFolderEntry>>) =>
        Effect.gen(function* () {
          let deferred: Array<StPlanned<StFolderEntry>> = []
          /** False once the import ended under it: another run took over, or it was cancelled. */
          const sendAll = (entries: ReadonlyArray<StPlanned<StFolderEntry>>, orphan: boolean) =>
            Effect.gen(function* () {
              for (const entry of entries) {
                if (live.cancelled || live.ended) return false
                live.currentFile = entry.path
                const sent = yield* sendWithRestart(
                  live.user,
                  live.id,
                  root,
                  { path: entry.path, size: entry.size, modifiedMs: entry.item.modifiedMs },
                  { card: null, orphan },
                  (read) =>
                    Effect.suspend(() => {
                      live.bytesDone = live.bytesBase + Math.min(read, entry.size)
                      return tick(live)
                    })
                ).pipe(
                  Effect.map((result) => ({ _tag: "Done" as const, result })),
                  Effect.catchTags({
                    // The import ended: another run of the user's started, or it went idle.
                    NotFound: () => Effect.succeed({ _tag: "Gone" as const }),
                    StFolderUnreadable: (error) => Effect.succeed({ _tag: "NotSent" as const, message: error.message }),
                    StImportFailed: (error) => Effect.succeed({ _tag: "NotSent" as const, message: error.message })
                  })
                )
                if (sent._tag === "Gone") return false
                if (sent._tag === "Done" && sent.result.outcome === "deferred") {
                  deferred.push(entry)
                  live.bytesDone = live.bytesBase
                  continue
                }
                if (sent._tag === "NotSent") notSent(live, entry.path, sent.message)
                live.filesDone++
                live.bytesBase += entry.size
                live.bytesDone = live.bytesBase
                yield* tick(live)
              }
              return true
            })
          let going = yield* sendAll(files, false)
          while (going && deferred.length > 0) {
            const waiting = deferred
            deferred = []
            going = yield* sendAll(waiting, false)
            if (going && deferred.length === waiting.length) {
              const orphans = deferred
              deferred = []
              going = yield* sendAll(orphans, true)
            }
          }
          return going
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? live.cancelled
                ? end(live, "cancelled", null)
                : exit.value
                  ? end(live, "complete", null)
                  : end(live, "interrupted", "Another import started while this one was running.")
              : Cause.hasInterruptsOnly(exit.cause)
                ? end(
                    live,
                    "interrupted",
                    "The server stopped during this import. Import the folder again to go on from where it was."
                  )
                : Effect.logError("an ST path import failed", exit.cause).pipe(
                    Effect.andThen(
                      end(live, "failed", "The import failed on the server. Import the folder again to go on.")
                    )
                  )
          )
        )

      const startPath = (user: User, path: string, prefix: string) =>
        Effect.gen(function* () {
          const scanned = yield* scanStFolder(path)
          if (!findStRoots(scanned.files.map((file) => file.path)).some((root) => root.prefix === prefix))
            return yield* new StFolderUnreadable({ message: "That ST user's folder isn't in this folder." })
          const plan = stPlan(scanned.files, prefix)
          if (plan.send.length === 0)
            return yield* new StFolderUnreadable({ message: "That ST user's folder has nothing the import reads." })
          // Read from the ST user's folder, where the plan's paths are.
          const root = prefix === "" ? scanned.root : `${scanned.root}/${prefix.slice(0, -1)}`
          const files = orderStBranches(plan.send, (entry) => entry.item.mainChat)
          return yield* starting.withPermits(1)(
            Effect.gen(function* () {
              yield* busy(user)
              const importId = yield* imports.start(user, plan.unsupported)
              const live = yield* begin(
                user,
                importId,
                "path",
                root,
                root,
                prefix,
                files.length,
                files.reduce((sum, file) => sum + file.size, 0)
              ).pipe(stored("Starting the import"))
              yield* Effect.forkIn(runPath(live, root, files), scope)
              return importId
            })
          )
        })

      const startUpload = (
        user: User,
        unsupported: ReadonlyArray<string>,
        info: { readonly source: string; readonly files: number; readonly bytes: number }
      ) =>
        starting.withPermits(1)(
          Effect.gen(function* () {
            yield* busy(user)
            const importId = yield* imports.start(user, unsupported)
            yield* begin(user, importId, "upload", info.source, null, "", info.files, info.bytes).pipe(
              stored("Starting the import")
            )
            return importId
          })
        )

      /** A finished job's report again, from its run still in memory, after the user acted on it. */
      const saveFinished = (user: User, importId: string) =>
        Effect.gen(function* () {
          const report = yield* Effect.option(imports.report(user, importId))
          if (Option.isNone(report)) return
          const detail = yield* reader.GetStImportJob({ userId: user.id, id: importId })
          yield* writer.StImportJobReport({
            userId: user.id,
            id: importId,
            reportJson: encodeReport(report.value),
            countsJson: JSON.stringify(report.value.counts),
            attention: attentionOf(report.value, decodeNotSent(detail.notSentJson).length)
          })
          publish({ user, id: importId }, detail.job.status)
        }).pipe(Effect.catch((error) => Effect.logWarning("saving an ST import's report failed", error)))

      const arrived = (
        user: User,
        importId: string,
        path: string,
        bytes: number,
        outcome: StFileResult | { readonly failed: string }
      ) =>
        Effect.gen(function* () {
          const live = lives.get(importId)
          if (live === undefined || live.user.id !== user.id) {
            // A chat linked from a finished upload's report, sent again from the same tab.
            if (!("failed" in outcome) && outcome.outcome !== "continue") yield* saveFinished(user, importId)
            return
          }
          live.lastActivity = Date.now()
          if (live.currentFile !== path) {
            live.currentFile = path
            live.currentBytes = 0
          }
          live.currentBytes += bytes
          const result = "failed" in outcome ? null : outcome.outcome
          if (result === "deferred" || result === "restart") live.currentBytes = 0
          else if (result !== "continue") {
            if (result === null) notSent(live, path, (outcome as { readonly failed: string }).failed)
            live.filesDone = Math.min(live.filesTotal || Infinity, live.filesDone + 1)
            live.bytesBase += live.currentBytes
            live.currentBytes = 0
          }
          live.bytesDone = Math.min(live.bytesTotal || Infinity, live.bytesBase + live.currentBytes)
          yield* tick(live)
        })

      const finishUpload = (user: User, importId: string, sent: ReadonlyArray<StNotSent>) =>
        Effect.gen(function* () {
          const live = lives.get(importId)
          if (live === undefined || live.user.id !== user.id) {
            // Already over (cancelled, or ended by another run): nothing to finish.
            yield* reader.GetStImportJob({ userId: user.id, id: importId })
            return
          }
          const known = new Set(live.notSent.map((entry) => entry.path))
          for (const entry of sent) if (!known.has(entry.path)) notSent(live, entry.path, entry.message)
          live.filesDone = live.filesTotal
          live.bytesDone = live.bytesTotal
          yield* end(live, "complete", null)
        }).pipe(stored("Finishing the import"))

      // An upload whose files stopped arriving is over: its tab was closed, or it lost the server.
      const sweep = Effect.gen(function* () {
        const now = Date.now()
        for (const live of [...lives.values()]) {
          if (live.mode !== "upload" || now - live.lastActivity < UPLOAD_IDLE_MS) continue
          imports.end(live.user, live.id)
          yield* end(
            live,
            "interrupted",
            "Its files stopped arriving for 10 minutes: the tab sending them was closed or lost the server. Import the folder again to go on."
          )
        }
      })
      yield* Effect.forkIn(Effect.repeat(sweep, Schedule.spaced(SWEEP_MS)), scope)

      const get = (user: User, importId: string) =>
        Effect.gen(function* () {
          const detail = yield* reader.GetStImportJob({ userId: user.id, id: importId })
          // Only a finished import's report offers it.
          const latest = detail.job.status === "running" ? null : yield* reader.StImportLatestChat({ userId: user.id })
          return new StImportJobDetail({
            job: detail.job,
            report: detail.reportJson === null ? null : decodeReport(detail.reportJson),
            notSent: decodeNotSent(detail.notSentJson),
            latestChat: latest === null ? null : new StImportedChat(latest)
          })
        }).pipe(stored("Reading the import"))

      const cancel = (user: User, importId: string) =>
        Effect.gen(function* () {
          const live = lives.get(importId)
          if (live === undefined || live.user.id !== user.id) {
            // A finished import has nothing to stop.
            yield* reader.GetStImportJob({ userId: user.id, id: importId })
            return
          }
          live.cancelled = true
          // An upload stops now: the files still on their way are refused. A path import
          // stops after the file it's on.
          if (live.mode === "upload") {
            imports.end(user, importId)
            yield* end(live, "cancelled", null)
          }
        }).pipe(stored("Cancelling the import"))

      /** A run that knows the folder again, for linking a chat of an import whose run is gone. */
      const rebuild = (user: User, root: string, card: EntityId | "none") =>
        Effect.gen(function* () {
          const helper = yield* imports.start(user, [])
          const scanned = yield* scanStFolder(root)
          const cards = new Set(card === "none" ? [] : imports.sourcesOf(user, helper, card))
          // What a chat links to: the settings, personas, lorebooks, presets, groups, and the chosen card.
          const context = stPlan(scanned.files, "").send.filter(
            (entry) =>
              (entry.kind !== "card" && entry.kind !== "chat" && entry.kind !== "group_chat") || cards.has(entry.path)
          )
          for (const entry of context) {
            yield* sendWithRestart(
              user,
              helper,
              scanned.root,
              { path: entry.path, size: entry.size, modifiedMs: entry.item.modifiedMs },
              { card: null, orphan: false },
              () => Effect.void
            ).pipe(Effect.catchTags({ StFolderUnreadable: () => Effect.void, StImportFailed: () => Effect.void }))
          }
          return helper
        })

      const link = (user: User, importId: string, path: string, card: EntityId | "none") =>
        starting
          .withPermits(1)(
            Effect.gen(function* () {
              const detail = yield* reader.GetStImportJob({ userId: user.id, id: importId })
              yield* busy(user)
              if (detail.job.mode !== "path" || detail.root === null)
                return yield* new StFolderUnreadable({
                  message:
                    "This import's files were sent from a browser, so the server can't read this chat again. Import the folder again from a browser, then link the chat in that import's report."
                })
              const root = detail.root
              const file = classifyStPath(path)
              const report = detail.reportJson === null ? null : decodeReport(detail.reportJson)
              if (file?.kind !== "chat" || report === null || !report.links.some((choice) => choice.path === path))
                return yield* new StFolderUnreadable({ message: "That chat isn't waiting for a card in this import." })
              const own = imports.exists(user, importId)
              let run = importId
              if (!own) {
                const helper = helpers.get(importId)
                if (helper !== undefined && imports.exists(user, helper)) run = helper
                else {
                  run = yield* rebuild(user, root, card)
                  helpers.set(importId, run)
                }
              }
              const seen = yield* statStFolderFile(root, path)
              const entry = { path, ...seen }
              let result = yield* sendWithRestart(user, run, root, entry, { card, orphan: false }, () => Effect.void)
              // A branch whose parent never came: on its own, as at the end of an import.
              if (result.outcome === "deferred")
                result = yield* sendWithRestart(user, run, root, entry, { card, orphan: true }, () => Effect.void)
              if (own) {
                yield* saveFinished(user, importId)
                return result
              }
              // The job's own report, with this chat linked: the helper run knows only this chat.
              const helped = yield* Effect.option(imports.report(user, run))
              const counts = Object.fromEntries(
                Object.entries(report.counts).map(([kind, count]) => [kind, new StCount(count)])
              )
              const outcome = result.outcome
              if (
                outcome === "added" ||
                outcome === "updated" ||
                outcome === "unchanged" ||
                outcome === "skipped" ||
                outcome === "failed"
              ) {
                const count = counts.chat ?? new StCount({ added: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 })
                counts.chat = new StCount({ ...count, [outcome]: count[outcome] + 1 })
              }
              const shown = path.replaceAll("\n", " ")
              const next = new StImportReport({
                ...report,
                counts,
                links: report.links.filter((choice) => choice.path !== path || outcome === "needs_link"),
                hiddenRuns: [
                  ...report.hiddenRuns,
                  ...(Option.isSome(helped)
                    ? helped.value.hiddenRuns.filter(
                        (run) => !report.hiddenRuns.some((had) => had.chatId === run.chatId)
                      )
                    : [])
                ],
                issues: [
                  ...report.issues,
                  ...(Option.isSome(helped) ? helped.value.issues.filter((issue) => issue.path === shown) : [])
                ]
              })
              yield* writer.StImportJobReport({
                userId: user.id,
                id: importId,
                reportJson: encodeReport(next),
                countsJson: JSON.stringify(next.counts),
                attention: attentionOf(next, decodeNotSent(detail.notSentJson).length)
              })
              publish({ user, id: importId }, detail.job.status)
              return result
            })
          )
          .pipe(
            Effect.catchTags({
              StImportFailed: (error) => Effect.fail(new ServerError({ message: error.message })),
              NotFound: (error) =>
                error.entity === "import"
                  ? Effect.fail(error)
                  : Effect.fail(new ServerError({ message: "The import of this chat ended meanwhile; try again." }))
            }),
            stored("Linking the chat")
          )

      const unhidden = (user: User, importId: string, chatId: ChatId) =>
        Effect.gen(function* () {
          imports.unhidden(user, chatId)
          if (lives.has(importId)) return
          const detail = yield* reader.GetStImportJob({ userId: user.id, id: importId })
          if (detail.reportJson === null) return
          const report = decodeReport(detail.reportJson)
          if (!report.hiddenRuns.some((run) => run.chatId === chatId)) return
          const next = new StImportReport({
            ...report,
            hiddenRuns: report.hiddenRuns.filter((run) => run.chatId !== chatId)
          })
          yield* writer.StImportJobReport({
            userId: user.id,
            id: importId,
            reportJson: encodeReport(next),
            countsJson: JSON.stringify(next.counts),
            attention: attentionOf(next, decodeNotSent(detail.notSentJson).length)
          })
          publish({ user, id: importId }, detail.job.status)
        }).pipe(Effect.catch((error) => Effect.logWarning("updating an ST import's report failed", error)))

      return StImportJobs.of({
        startPath,
        startUpload,
        arrived,
        finishUpload,
        list: (user) => reader.ListStImportJobs({ userId: user.id }).pipe(stored("Listing imports")),
        get,
        seen: (user, importId) =>
          writer
            .StImportJobSeen({ userId: user.id, id: importId, at: Date.now() })
            .pipe(stored("Marking the import seen")),
        cancel,
        clear: (user, importId) =>
          writer.StImportJobsClear({ userId: user.id, id: importId }).pipe(stored("Clearing imports")),
        link,
        unhidden
      })
    })
  )
}
