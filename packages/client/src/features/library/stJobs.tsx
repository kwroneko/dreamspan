// ST folder imports as the server keeps them (ARCHITECTURE.md §13): the user's import jobs in
// one query with its own reactivity key, refreshed when the server says one changed
// (StImportChanged, at most about once a second per job), and the shell's line saying an
// import is running, or finished while the user was elsewhere. While one runs, what the
// library and the chats show is read again at most every 10 s, and once when it ends:
// never per file.
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import type { StImportJob } from "@rp/shared/stImportApi.ts"
import { Link, useLocation } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useContext, useEffect } from "react"
import { invalidateKeys } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { ProgressBar, Spinner } from "../../ui/Spinner.tsx"
import { userNoticeReceivers } from "../noticeContributions.tsx"

/** The reactivity key of the import jobs. */
export const ST_IMPORTS = "st-imports"

/** The reactivity key of a folder's preview (what's already here): read again when an import ends. */
export const ST_PREVIEW = "st-import-preview"

export const stImportsAtom = AppClient.query("ListStImports", undefined, { reactivityKeys: [ST_IMPORTS] })

/** How often, at most, an import's progress makes the library and chats be read again. */
const DATA_EVERY_MS = 10_000

/** Uploads this tab must stop sending: cancelled, or ended elsewhere. */
export const stoppedUploads = new Set<string>()

/** Hears about imports for this tab: registered as an app tool, so a plugin can replace it. */
export function StImportWatcher() {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = 0
    const reloadData = () => {
      timer = null
      last = Date.now()
      invalidateKeys(registry, ["library", "chats"])
    }
    const off = userNoticeReceivers.register({
      id: "library.st-imports",
      receive: (notice) => {
        if (notice._tag !== "StImportChanged") return
        invalidateKeys(registry, [ST_IMPORTS])
        if (notice.status === "running") {
          if (timer === null) timer = setTimeout(reloadData, Math.max(0, last + DATA_EVERY_MS - Date.now()))
          return
        }
        stoppedUploads.add(notice.importId)
        if (timer !== null) clearTimeout(timer)
        invalidateKeys(registry, [ST_PREVIEW])
        reloadData()
      }
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      off()
    }
  }, [registry])
  return null
}

/** How far a job is, by bytes (a chat can be most of a folder), as a whole percentage. */
export const percentOf = (job: StImportJob) =>
  job.bytesTotal > 0
    ? Math.min(100, Math.floor((job.bytesDone / job.bytesTotal) * 100))
    : job.filesTotal > 0
      ? Math.min(100, Math.floor((job.filesDone / job.filesTotal) * 100))
      : 0

export const STATUS_LABELS = {
  running: "Running",
  complete: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Stopped before the end"
} as const

export const STATUS_TONES = {
  running: "accent",
  complete: "success",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warning"
} as const

/** The job the shell speaks of: the newest running, else the newest finished one not opened since. */
const shownJob = (jobs: ReadonlyArray<StImportJob>) =>
  jobs.find((job) => job.status === "running") ?? jobs.find((job) => !job.seen)

const endedLine = (job: StImportJob) => {
  if (job.status === "complete")
    return job.attention > 0 ? `ST import finished · ${job.attention} to look at` : "ST import finished"
  if (job.status === "failed") return "ST import failed"
  if (job.status === "cancelled") return "ST import cancelled"
  return "ST import stopped before the end"
}

/** The shell's line about imports, on every screen but the import page, which shows them itself. */
export function StImportIndicator() {
  const onPage = useLocation({ select: (location) => location.pathname === "/import/st" })
  const result = useAtomValue(stImportsAtom)
  if (onPage || !AsyncResult.isSuccess(result)) return null
  const job = shownJob(result.value)
  if (job === undefined) return null
  const running = job.status === "running"
  const tone =
    job.status === "failed"
      ? "text-danger"
      : job.status === "interrupted"
        ? "text-warning"
        : job.status === "complete"
          ? "text-success"
          : "text-text"
  const percent = percentOf(job)
  return (
    <div
      role="status"
      aria-label="ST import"
      className="flex min-w-0 items-center gap-3 border-b border-border bg-surface-raised px-4 py-2 text-sm"
    >
      {running && <Spinner className="text-accent" />}
      <span className={`min-w-0 truncate font-medium ${tone}`}>
        {running ? `Importing ST data · ${percent}%` : endedLine(job)}
      </span>
      {running && (
        <ProgressBar className="hidden h-1.5 w-32 shrink-0 sm:block" max={100} value={percent} label="Imported" />
      )}
      <Link
        to="/import/st"
        search={{ job: job.id }}
        className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-accent underline-offset-4 hover:underline"
      >
        {running ? "View" : "Open"}
      </Link>
    </div>
  )
}
