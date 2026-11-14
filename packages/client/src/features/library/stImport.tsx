import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
// Importing a SillyTavern data folder (DESIGN §1.4, ARCHITECTURE.md §13). The page lists the
// user's imports, running and past, each opening to its report, and starts one: a folder
// named by its path is imported by the server as a job that goes on whatever this tab does;
// one picked in the browser (from another machine) is sent from this tab, file by file, and
// its job records the files as they arrive. Its sections are registered parts
// (`stImportSections`), so a plugin can replace or remove one. Report text quotes files, so
// it's rendered as text.
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { formatByteSize } from "@rp/shared/byteSize.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { StRoot } from "@rp/shared/stFolder.ts"
import type {
  StFolderEntry,
  StHiddenRun,
  StImportJob,
  StImportJobDetail,
  StImportReport,
  StLinkChoice,
  StPlanChoice
} from "@rp/shared/stImportApi.ts"
import { type StSentKind, stPlan, stPlanKinds, stSendRounds } from "@rp/shared/stPlan.ts"
import { ST_CHANGED_SINCE_CHECK } from "@rp/shared/stReimportPlan.ts"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { Context, Effect } from "effect"
import { AsyncResult, AtomRegistry } from "effect/reactivity"
import { useContext, useEffect, useMemo, useRef, useState } from "react"
import { AsyncView, ErrorAlert, invalidateKeys, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { sessionAtom, useSession } from "../../session.ts"
import { SlotOutlet } from "../../slots.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { FileDrop } from "../../ui/FileDrop.tsx"
import { Select } from "../../ui/Select.tsx"
import { ProgressBar } from "../../ui/Spinner.tsx"
import { Alert, Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { readableChatTitle } from "../chat/chatTitle.ts"
import { ImportLog, reportIssues } from "./stImportIssues.tsx"
import { Menu, MenuItem } from "../../ui/Menu.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useTitle } from "../shell.tsx"
import { libraryAtom } from "./data.ts"
import { ReimportPlan } from "./stReimportPlan.tsx"
import { FolderBrowser } from "./FolderBrowser.tsx"
import { type StImportSectionProps, stImportSections } from "./slots.ts"
import { askMediaApproval } from "../savedMedia/approval.ts"
import {
  percentOf,
  ST_IMPORTS,
  ST_PREVIEW,
  STATUS_LABELS,
  STATUS_TONES,
  stImportsAtom,
  stoppedUploads
} from "./stJobs.tsx"
import {
  orderedPlan,
  pickedFiles,
  pickedName,
  sendStFile,
  type StExtra,
  type StFolderFile,
  type StFound,
  type StSent,
  stRoots
} from "./stUpload.ts"

/** Compact result stats, including kinds with nothing imported. */
const KINDS = [
  ["card", "Cards"],
  ["gallery", "Gallery images"],
  ["chat", "Chats"],
  ["preset", "Presets"],
  ["lorebook", "Lorebooks"],
  ["persona", "Personas"]
] as const

/** The preview's kinds, as the folder's files are found (`stPlan`). */
const FOLDER_KINDS: ReadonlyArray<readonly [StSentKind, string]> = [
  ["card", "Cards"],
  ["gallery", "Gallery images"],
  ["persona_avatar", "Personas"],
  ["chat", "Chats"],
  ["group_chat", "Group chats"],
  ["group", "Groups"],
  ["world", "Lorebooks"],
  ["preset", "Presets"],
  ["settings", "Settings"]
]

const OUTCOMES = ["added", "updated", "failed"] as const

/** Where the folder browser starts: the folder last looked in on this device, else the newest path import's. */
const LAST_FOLDER = "rp.st-import.folder"

const lastFolder = (jobs: ReadonlyArray<StImportJob>) => {
  try {
    const stored = localStorage.getItem(LAST_FOLDER)
    if (stored) return stored
  } catch {
    // Storage refused (a private window): the newest import's folder still serves.
  }
  return jobs.find((job) => job.mode === "path")?.source ?? null
}

/** Changes to these after an import's report is acted on. */
const AFTER_ACTION = [ST_IMPORTS, "library", "chats"]

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

const took = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** What a job imported, in one line: added, updated and failed across kinds. */
const countsLine = (job: StImportJob) => {
  const total = { added: 0, updated: 0, failed: 0 }
  for (const count of Object.values(job.counts)) for (const outcome of OUTCOMES) total[outcome] += count[outcome]
  const parts = OUTCOMES.filter((outcome) => total[outcome] > 0).map((outcome) => `${total[outcome]} ${outcome}`)
  return parts.length > 0 ? parts.join(" · ") : "Nothing new"
}

// --- Uploads: files this tab sends, which a report's link choices need again.

/** The files of each upload this tab sent, by path, for a chat linked from its report. */
const uploads = new Map<string, ReadonlyMap<string, StFolderFile>>()

/** A call to the server outside a component, as `useAction` makes one. */
const call = <A, E>(registry: AtomRegistry.AtomRegistry, run: (client: AppClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(
    Effect.flatMap(AtomRegistry.getResult(registry, AppClient.runtime), (services) =>
      run(Context.get(services, AppClient))
    )
  )

const warnBeforeLeaving = (event: BeforeUnloadEvent) => event.preventDefault()

/**
 * Sends an upload's files in order, chats in parts; branches deferred until their parent is
 * in are sent again until none goes in, then on their own. It belongs to no component, so
 * going to another page of the app doesn't stop it; closing the tab does, and the server
 * ends the job as stopped once its files stop arriving.
 */
const sendUpload = async (
  registry: AtomRegistry.AtomRegistry,
  importId: string,
  files: ReadonlyArray<StFolderFile>
) => {
  window.addEventListener("beforeunload", warnBeforeLeaving)
  const lost: Array<{ path: string; message: string }> = []
  const send = async (entry: StFolderFile, extra: StExtra) => {
    const answer = await sendStFile(importId, entry, extra, () => {})
    // The server lost the chat's earlier parts (it restarted): once more from the start.
    return answer._tag === "Done" && answer.result.outcome === "restart"
      ? sendStFile(importId, entry, extra, () => {})
      : answer
  }
  // The rounds a path import and the re-import preview go by too (`stSendRounds`).
  const sendAll = async () => {
    const rounds = stSendRounds(files)
    for (let step = rounds.next(); !step.done; ) {
      const { entry, orphan } = step.value
      if (stoppedUploads.has(importId)) return false
      const answer = await send(entry, orphan ? { orphan: true } : {})
      if (answer._tag === "Unauthorized") {
        registry.refresh(sessionAtom)
        return false
      }
      // Cancelled, or another import started: the server takes no more of it.
      if (answer._tag === "Gone") return false
      if (answer._tag === "Failed") lost.push({ path: entry.path, message: answer.message })
      step = rounds.next(answer._tag === "Done" && answer.result.outcome === "deferred")
    }
    return true
  }
  try {
    const going = await sendAll()
    if (going) await call(registry, (client) => client("FinishStImport", { importId, notSent: lost.slice(0, 2000) }))
  } finally {
    window.removeEventListener("beforeunload", warnBeforeLeaving)
    invalidateKeys(registry, AFTER_ACTION)
  }
}

/** A chat of an upload's report sent again with the card chosen; null when it went in. */
const linkUploaded = async (importId: string, path: string, card: EntityId | "none"): Promise<string | null> => {
  const entry = uploads.get(importId)?.get(path)
  if (entry === undefined)
    return "This import's files were sent from a browser and aren't here any more. Choose the folder again below and import it, then link the chat in that import's report."
  let answer: StSent = await sendStFile(importId, entry, { card }, () => {})
  // A branch whose parent never came: it's imported on its own, as at the end of the import.
  if (answer._tag === "Done" && answer.result.outcome === "deferred")
    answer = await sendStFile(importId, entry, { card, orphan: true }, () => {})
  if (answer._tag === "Unauthorized") return "Your session has ended."
  if (answer._tag === "Gone")
    return "Another import has started since, so this one can't take the chat. Link it in that import's report."
  if (answer._tag === "Failed") return answer.message
  if (answer.result.outcome === "failed") return answer.result.message || "The chat couldn't be imported."
  return null
}

// --- The report

function Counts({ job, issues }: { job: StImportJob; issues: ReturnType<typeof reportIssues> }) {
  const imported = (kind: string) => {
    const count = job.counts[kind]
    return count ? count.added + count.updated : 0
  }
  const stats = [
    ...KINDS.map(([kind, label]) => [label, imported(kind) + (kind === "chat" ? imported("group_chat") : 0)] as const),
    ["Warnings", issues.filter((issue) => issue.level === "warning").length] as const,
    ["Errors", issues.filter((issue) => issue.level === "error").length] as const
  ]
  return (
    <ul
      aria-label={job.status === "running" ? "Import progress" : "Imported"}
      className="flex flex-wrap gap-x-5 gap-y-2 text-sm"
    >
      {stats.map(([label, count]) => (
        <li key={label}>
          <span className="text-muted">{label}:</span> <span className="font-semibold tabular-nums">{count}</span>
        </li>
      ))}
    </ul>
  )
}

function LinkChoiceRow({
  choice,
  onChoose,
  blocked
}: {
  choice: StLinkChoice
  blocked: boolean
  onChoose: (card: EntityId | "none") => Promise<string | null>
}) {
  const library = useAtomValue(libraryAtom)
  const [card, setCard] = useState<string | null>(choice.candidates[0]?.entityId ?? null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Without candidates, any card of the library; the server checks it's the user's.
  const others =
    choice.candidates.length === 0 && AsyncResult.isSuccess(library)
      ? library.value.card.map((ref) => ({ value: ref.entityId as string, label: ref.label }))
      : []
  const items = [
    ...choice.candidates.map((candidate) => ({ value: candidate.entityId as string, label: candidate.label })),
    ...others,
    { value: "none", label: "No card", description: "Imports it without linking it to any of your cards." }
  ]
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
      <p className="min-w-0 flex-1 basis-64 text-sm [overflow-wrap:anywhere]">
        {choice.path.startsWith("chats/undefined/")
          ? `Chat “${choice.title}” was saved without a character.`
          : `Chat “${choice.title}”: ${choice.reason.replace(" ST's card for this chat may have been deleted or renamed.", "")}`}
      </p>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        <Tooltip label="Choose the card to link to this chat.">
          <span className="w-44 max-w-full">
            <Select
              ariaLabel={`Card for ${choice.title}`}
              items={items}
              value={card}
              onValueChange={setCard}
              placeholder="Choose a card"
            />
          </span>
        </Tooltip>
        <Button
          disabled={card === null || blocked}
          pending={pending}
          hint={
            blocked
              ? "Wait for the import to finish before linking this chat."
              : "Imports this chat with the selected card."
          }
          onClick={async () => {
            setPending(true)
            // The report's candidates are the user's cards, or "none".
            setError(await onChoose(card as EntityId | "none"))
            setPending(false)
          }}
        >
          Import with this card
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </li>
  )
}

/** The parts of a report that ask the user to act: chats to link, hidden runs, issues. */
function ReportActions({
  job,
  report,
  linkNote
}: {
  job: StImportJob
  report: StImportReport
  linkNote: string | null
}) {
  const action = useAction()
  const registry = useContext(RegistryContext)
  const navigate = useNavigate()
  const choose = async (path: string, card: EntityId | "none") => {
    if (job.mode === "upload") {
      const error = await linkUploaded(job.id, path, card)
      invalidateKeys(registry, AFTER_ACTION)
      return error
    }
    const linked = await action.run(
      (client) => client("LinkStImportChat", { importId: job.id, path, card }),
      AFTER_ACTION
    )
    if (!linked.ok) return linked.error.message
    return linked.value.outcome === "failed" ? linked.value.message || "The chat couldn't be imported." : null
  }
  // Files the confirmed check no longer described: nothing of them went in.
  const refused = report.issues.filter((issue) => issue.code === ST_CHANGED_SINCE_CHECK)
  const count = report.links.length + report.hiddenRuns.length + refused.length
  if (count === 0) return null
  const unhide = ({ chatId, throughSlotId }: StHiddenRun) =>
    void action.run((client) => client("UnhideImportedRun", { chatId, throughSlotId, importId: job.id }), AFTER_ACTION)
  return (
    <Card>
      <CardHeader title={`Needs your action (${count})`} />
      <ErrorAlert error={action.error} />
      {refused.length > 0 && (
        <div className="mb-3 border-b border-border pb-3 last:mb-0 last:border-b-0 last:pb-0">
          <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted">
              {refused.length === 1 ? "This chat changed" : "These chats changed"} after the check, so{" "}
              {refused.length === 1 ? "it wasn't" : "they weren't"} imported.
            </p>
            <Button
              className="self-start sm:self-auto"
              disabled={job.status === "running"}
              hint={
                job.mode === "path"
                  ? "Checks the folder again, so you can import what changed."
                  : "Opens the import form: choose the folder again to check it."
              }
              onClick={() => void navigate({ to: "/import/st", search: { job: job.id, again: job.id } })}
            >
              Check again
            </Button>
          </div>
          <ul aria-label="Not imported" className="flex flex-col gap-1">
            {refused.map((issue) => (
              <li key={issue.path} className="text-sm [overflow-wrap:anywhere]">
                {issue.path}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.links.length > 0 && (
        <div>
          {linkNote && <p className="mb-3 text-sm text-muted">{linkNote}</p>}
          <ul aria-label="Chats to link" className="flex flex-col divide-y divide-border">
            {report.links.map((choice) => (
              <LinkChoiceRow
                key={choice.path}
                choice={choice}
                blocked={job.status === "running"}
                onChoose={(card) => choose(choice.path, card)}
              />
            ))}
          </ul>
        </div>
      )}
      {report.hiddenRuns.length > 0 && (
        <div className={report.links.length ? "mt-3 border-t border-border pt-3" : ""}>
          <ul aria-label="Hidden runs" className="flex flex-col divide-y divide-border">
            {report.hiddenRuns.map((run) => (
              <li
                key={run.chatId}
                className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm">
                    <Tooltip label="Opens the chat with these hidden messages.">
                      <Link
                        to="/chats/$chatId"
                        params={{ chatId: run.chatId }}
                        className="font-medium text-accent underline-offset-4 [overflow-wrap:anywhere] hover:underline"
                      >
                        {readableChatTitle(run.title)}
                      </Link>
                    </Tooltip>
                    <span className="text-muted">
                      {` has ${run.hidden} messages hidden from the start; `}
                      {run.summaryCovers === true
                        ? "its summary covers them, so un-hiding sends them twice."
                        : run.summaryCovers === false
                          ? "its summary doesn't cover all of them."
                          : "the chat has no summary."}
                    </span>
                  </p>
                </div>
                <Button
                  disabled={job.status === "running"}
                  hint="Includes the hidden messages in this chat’s context."
                  onClick={() => unhide(run)}
                >
                  Un-hide
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

// --- One import

const useNow = (running: boolean) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

function Result({ detail }: { detail: StImportJobDetail }) {
  const { job } = detail
  const action = useAction()
  const running = job.status === "running"
  const now = useNow(running)
  const issues = reportIssues(detail)
  useEffect(() => {
    if (!running && !job.seen) {
      void action.run((client) => client("SeenStImport", { importId: job.id }), [ST_IMPORTS])
      // The sites its media is on that the user hasn't approved, from every waiting file (spec/SAVED-MEDIA.md §3.2).
      askMediaApproval(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mark each finished import once when opened
  }, [job.id, job.seen, running])
  return (
    <>
      <Card>
        <CardHeader title="Result" />
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm" role={running ? "status" : undefined}>
          <Badge tone={STATUS_TONES[job.status]}>{STATUS_LABELS[job.status]}</Badge>
          <span className="text-muted">
            {when(job.startedAt)} · {took((job.finishedAt ?? now) - job.startedAt)}
          </span>
          {running && (
            <span>
              {job.filesDone} of {job.filesTotal} files · {percentOf(job)}%
            </span>
          )}
        </p>
        <Counts job={job} issues={issues} />
        {running && (
          <div className="mt-3 flex flex-col gap-2 text-sm">
            <ProgressBar
              className="h-2 w-full"
              max={Math.max(1, job.bytesTotal)}
              value={job.bytesDone}
              label="Imported so far"
            />
            {job.currentFile && <span className="text-muted [overflow-wrap:anywhere]">{job.currentFile}</span>}
            <p className="text-muted">
              {job.mode === "path"
                ? "You can close this tab while the import runs."
                : "Keep the tab that started this import open until it finishes."}
            </p>
            <Button
              className="self-start"
              pending={action.pending}
              hint="Stops the import after the current file."
              onClick={() => {
                stoppedUploads.add(job.id)
                void action.run((client) => client("CancelStImport", { importId: job.id }), [ST_IMPORTS])
              }}
            >
              Cancel import
            </Button>
          </div>
        )}
        <ErrorAlert error={action.error} />
      </Card>
      {detail.report && (
        <ReportActions
          job={job}
          report={detail.report}
          linkNote={
            job.mode === "upload" && !uploads.has(job.id)
              ? "Linking this chat needs the files again; import the folder from this browser."
              : null
          }
        />
      )}
      <ImportLog detail={detail} />
    </>
  )
}

/** An explicit history selection, otherwise the newest import, including a finished one. */
function JobSection({ opened }: StImportSectionProps) {
  const result = useAtomValue(stImportsAtom)
  const top = useRef<HTMLDivElement>(null)
  const job = AsyncResult.isSuccess(result)
    ? opened === null
      ? result.value[0]
      : result.value.find((job) => job.id === opened)
    : undefined
  const jobId = job?.id
  const atom = useMemo(
    () => (jobId ? AppClient.query("GetStImport", { importId: jobId }, { reactivityKeys: [ST_IMPORTS] }) : null),
    [jobId]
  )
  useEffect(() => {
    if (opened !== null) top.current?.scrollIntoView({ block: "start" })
  }, [opened])
  return (
    <div ref={top} className="flex scroll-mt-4 flex-col gap-6 empty:hidden">
      {atom ? (
        <AsyncView atom={atom} loading="Loading the report…">
          {(detail) => <Result key={detail.job.id} detail={detail} />}
        </AsyncView>
      ) : opened !== null && AsyncResult.isSuccess(result) ? (
        <Alert tone="warning" title="That import isn't in the list">
          It was removed from history.
        </Alert>
      ) : null}
    </div>
  )
}

// --- Starting one

type Plan = ReturnType<typeof stPlan<{ path: string; size: number }>>

/** At most this many paths go to StImportPreview; any beyond count as new. */
const PREVIEW_PATHS = 50_000

const cell = "px-2 py-1.5 text-right tabular-nums"

/**
 * The folder by kind: how many files, how many are new, how many earlier imports hold. A
 * folder named by its path (`folder`) is read too: files an earlier import holds under
 * another name, and chats holding only a greeting, which no import takes. Those get their own
 * column when there are any, so each row's columns add up to its files.
 */
function FolderPreview({ plan, folder }: { plan: Plan; folder: { root: string; prefix: string } | null }) {
  const atom = useMemo(
    () =>
      AppClient.query(
        "StImportPreview",
        {
          paths: plan.send.slice(0, PREVIEW_PATHS).map((entry) => entry.path),
          ...(folder === null ? {} : { folder })
        },
        { reactivityKeys: [ST_PREVIEW] }
      ),
    // The folder is a new object per render; its root and prefix are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, folder?.root, folder?.prefix]
  )
  const result = useAtomValue(atom)
  const known = AsyncResult.isSuccess(result) ? new Set(result.value.known) : null
  const kinds = stPlanKinds(
    plan.send,
    known ?? new Set(),
    AsyncResult.isSuccess(result) ? new Set(result.value.skipped) : new Set()
  )
  const rows = FOLDER_KINDS.flatMap(([kind, label]) => {
    const count = kinds.get(kind)
    return count === undefined ? [] : [{ kind, label, ...count }]
  })
  const bytes = plan.send.reduce((sum, entry) => sum + entry.size, 0)
  const fresh = rows.reduce(
    (sum, row) => sum + (row.kind === "settings" || row.kind === "group" ? 0 : row.files - row.known - row.skipped),
    0
  )
  const skipped = rows.reduce((sum, row) => sum + row.skipped, 0)
  const here = rows.reduce((sum, row) => sum + row.known, 0)
  const pending = known === null ? (AsyncResult.isFailure(result) ? "?" : "…") : null
  return (
    <div className="flex flex-col gap-2">
      <table aria-label="What's in the folder" className="w-full text-sm">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th scope="col" className="px-2 py-1.5 text-left font-medium">
              Kind
            </th>
            <th scope="col" className={`${cell} font-medium`}>
              In the folder
            </th>
            <th scope="col" className={`${cell} font-medium`}>
              New
            </th>
            <th scope="col" className={`${cell} font-medium`}>
              Already here
            </th>
            {skipped > 0 && (
              <th scope="col" className={`${cell} font-medium`}>
                Only a greeting
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.kind} className="border-b border-border last:border-b-0">
              <th scope="row" className="px-2 py-1.5 text-left font-medium">
                {row.label}
              </th>
              <td className={cell}>{row.files}</td>
              {row.kind === "settings" || row.kind === "group" ? (
                // Not kept as entries: read for what they say about the rest.
                <td colSpan={skipped > 0 ? 3 : 2} className="px-2 py-1.5 text-right text-muted">
                  read on every import
                </td>
              ) : (
                <>
                  <td
                    className={`${cell} ${row.files - row.known - row.skipped > 0 && pending === null ? "font-semibold" : ""}`}
                  >
                    {pending ?? row.files - row.known - row.skipped}
                  </td>
                  <td className={`${cell} text-muted`}>{pending ?? row.known}</td>
                  {skipped > 0 && <td className={`${cell} text-muted`}>{row.skipped}</td>}
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm text-muted">
        {plan.send.length} files ({formatByteSize(bytes)})
        {plan.unsupported.length > 0 &&
          `, and ${plan.unsupported.length} that only text completion uses, which aren't read`}
        .{" "}
        {known === null
          ? AsyncResult.isFailure(result)
            ? "What's already here couldn't be read; importing still adds only what's new."
            : null
          : fresh === 0
            ? here === 0
              ? "Nothing here to import."
              : "Everything here is already imported. Importing again takes in what changed since: new messages, edited cards."
            : here === 0
              ? `${fresh} new to import.`
              : `${fresh} new to import. What's already here is read again, and only what changed in it goes in.`}
        {skipped > 0 &&
          ` ${skipped} ${skipped === 1 ? "chat holds" : "chats hold"} only a greeting, as ST makes one when a card is opened: no import takes ${skipped === 1 ? "it" : "them"}, so they don't count as new.`}
      </p>
    </div>
  )
}

type Chosen =
  | { readonly _tag: "Path"; readonly root: string; readonly files: ReadonlyArray<StFolderEntry> }
  | { readonly _tag: "Picked"; readonly files: ReadonlyArray<StFound> }

function StartForm({ open, close, again }: StImportSectionProps & { close: (() => void) | null }) {
  const registry = useContext(RegistryContext)
  const action = useAction()
  const admin = useSession().user.role === "admin"
  const jobs = useAtomValue(stImportsAtom)
  const running = AsyncResult.isSuccess(jobs) && jobs.value.some((job) => job.status === "running")
  // The folder last looked in (on this device, else the newest path import's), so coming back
  // goes on from there.
  const last = AsyncResult.isSuccess(jobs) ? lastFolder(jobs.value) : null
  // Null until the user types or opens a folder: the field shows where the browser starts
  // (the last folder, else IMPORT_START_DIR, else the home folder), so a deployment can point it at ST's data.
  const [typedPath, setFolderPath] = useState<string | null>(null)
  const startAtom = useMemo(() => AppClient.query("ListFolder", { path: null }), [])
  const start = useAtomValue(startAtom)
  const folderPath = typedPath ?? last ?? (AsyncResult.isSuccess(start) ? start.value.path : "")
  // Where the browser starts: a typed folder once looked in, else the last folder; null is the home folder.
  const [browsed, setBrowsed] = useState<string | null>(null)
  const browserStart = browsed ?? last
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [roots, setRoots] = useState<ReadonlyArray<StRoot>>([])
  const [prefix, setPrefix] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [scanning, setScanning] = useState(false)
  // The re-import preview's choice once its check is done; a new round checks again.
  const [planChoice, setPlanChoice] = useState<StPlanChoice | null>(null)
  const [planRound, setPlanRound] = useState(0)

  const choose = (next: Chosen | null) => {
    const users = next === null ? [] : stRoots(next.files.map((file) => file.path))
    setPlanChoice(null)
    setPlanRound((round) => round + 1)
    setChosen(next)
    setRoots(users)
    setPrefix(users.length === 1 ? users[0]!.prefix : null)
  }

  const scan = async (path = folderPath.trim()) => {
    setScanning(true)
    const scanned = await action
      .run((client) => client("ScanStFolder", { path }))
      .finally(() => setScanning(false))
    if (!scanned.ok) return
    try {
      localStorage.setItem(LAST_FOLDER, scanned.value.root)
    } catch {
      // Not kept on this device: the newest import's folder still is.
    }
    // What's already here is read again: an import may have ended since the last look.
    invalidateKeys(registry, [ST_PREVIEW])
    choose({ _tag: "Path", root: scanned.value.root, files: scanned.value.files })
    // The browser shows a typed folder once it's known to be one.
    if (scanned.value.root !== browsed) setBrowsed(scanned.value.root)
  }

  // "Check again" in a report: that import's folder, read again and checked, once.
  const againJob = AsyncResult.isSuccess(jobs) ? jobs.value.find((job) => job.id === again) : undefined
  const againPath = admin && againJob?.mode === "path" ? againJob.source : null
  const checkedAgain = useRef<string | null>(null)
  useEffect(() => {
    if (againPath === null || checkedAgain.current === again) return
    checkedAgain.current = again
    setFolderPath(againPath)
    void scan(againPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per report asking
  }, [again, againPath])

  const plan = useMemo(
    () => (prefix === null || chosen === null ? null : stPlan<{ path: string; size: number }>(chosen.files, prefix)),
    [chosen, prefix]
  )

  const runImport = async () => {
    if (chosen === null || prefix === null) return
    if (planChoice === null) return
    const plan = planChoice
    setStarting(true)
    // Refused because the chats or the folder changed since the check: it's worked out again.
    const recheck = (tag: string) => {
      if (tag === "StImportPlanChanged") setPlanRound((round) => round + 1)
    }
    try {
      if (chosen._tag === "Path") {
        const started = await action.run(
          (client) => client("StartStPathImport", { path: chosen.root, prefix, plan }),
          [ST_IMPORTS]
        )
        if (!started.ok) return recheck(started.error.tag)
        choose(null)
        open(started.value.importId)
        return
      }
      const ordered = await orderedPlan(chosen.files, prefix)
      const { unsupported } = ordered
      // The chat files the user chose to skip in the preview aren't sent.
      const skipped = new Set(plan.skip)
      const send = ordered.send.filter((entry) => !skipped.has(entry.path))
      const bytes = send.reduce((sum, entry) => sum + entry.size, 0)
      const started = await action.run(
        (client) =>
          client("StartStImport", {
            unsupported,
            source: pickedName(chosen.files, prefix),
            files: send.length,
            bytes,
            plan
          }),
        [ST_IMPORTS]
      )
      if (!started.ok) return recheck(started.error.tag)
      const { importId } = started.value
      uploads.set(importId, new Map(send.map((entry) => [entry.path, entry])))
      choose(null)
      open(importId)
      void sendUpload(registry, importId, send)
    } finally {
      setStarting(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="SillyTavern data folder"
          about="Choose an ST installation, data folder or user folder."
          inline
          actions={
            close ? (
              <Button
                variant="ghost"
                className="h-8! w-8 px-0!"
                aria-label="Close import form"
                hint="Closes the import form."
                onClick={close}
              >
                <Icon name="close" />
              </Button>
            ) : undefined
          }
        />
        {admin && (
          <>
            <form
              className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
              onSubmit={(event) => {
                event.preventDefault()
                void scan()
              }}
            >
              <Field label="Folder path">
                <Input
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.target.value)}
                  placeholder="/home/you/SillyTavern/data"
                  className="w-full"
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                className="justify-self-start"
                disabled={folderPath.trim() === "" || action.pending}
                pending={scanning}
                hint="Lists the files in this folder and how many are new."
              >
                {scanning ? "Looking through the folder…" : "Look in this folder"}
              </Button>
            </form>
            <div className="mt-3">
              {/* After the imports are read, so it starts at the last folder rather than moving there. */}
              {!AsyncResult.isInitial(jobs) && (
                <FolderBrowser
                  key={browserStart ?? ""}
                  start={browserStart}
                  disabled={false}
                  onOpen={(path) => {
                    setFolderPath(path)
                    // What was found in another folder no longer applies.
                    choose(null)
                  }}
                />
              )}
            </div>
            <p className="mt-4 mb-2 text-sm text-muted">For a folder on this device, choose it below.</p>
          </>
        )}
        <FileDrop
          label="Choose the folder"
          description="Sends the selected folder from this tab, which must stay open until the import finishes."
          directory
          onFiles={(picked) => choose({ _tag: "Picked", files: pickedFiles(picked) })}
        />
      </Card>
      {chosen !== null && roots.length === 0 && (
        <Alert tone="warning" title="No SillyTavern data here">
          <p>This folder has no characters, chats or settings in ST's layout. Choose ST's data folder.</p>
        </Alert>
      )}
      {roots.length > 0 && (
        <Card>
          <CardHeader
            title="What's in it"
            description={
              roots.length > 1 ? "This folder has several ST users. Import one at a time into your account." : undefined
            }
          />
          <div className="flex flex-col gap-4">
            {roots.length > 1 && (
              <Field label="ST user">
                <Select
                  items={roots.map((root) => ({
                    value: root.prefix,
                    label: `${root.name || "(the folder itself)"} — ${root.files} files`
                  }))}
                  value={prefix}
                  onValueChange={setPrefix}
                  placeholder="Choose a user"
                />
              </Field>
            )}
            {plan && (
              <FolderPreview
                plan={plan}
                folder={chosen?._tag === "Path" && prefix !== null ? { root: chosen.root, prefix } : null}
              />
            )}
            {plan && chosen !== null && prefix !== null && (
              <ReimportPlan
                source={
                  chosen._tag === "Path"
                    ? { _tag: "Path", root: chosen.root, prefix }
                    : { _tag: "Picked", found: chosen.files, prefix }
                }
                round={planRound}
                onChoice={setPlanChoice}
              />
            )}
            {chosen?._tag === "Path" ? (
              <p className="text-sm text-muted">You can close this tab after starting the import.</p>
            ) : (
              <p className="text-sm text-muted">Keep this tab open until the import finishes.</p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={plan === null || plan.send.length === 0 || running || planChoice === null}
                pending={starting}
                hint="Adds what’s new, and takes in what changed since an earlier import, as shown above."
                onClick={() => void runImport()}
              >
                Import
              </Button>
              {running ? (
                <span className="text-sm text-muted">
                  One import at a time: this one can start when the running one is done.
                </span>
              ) : (
                planChoice === null &&
                plan !== null && (
                  <span className="text-sm text-muted">Import is available once the check above is done.</span>
                )
              )}
            </div>
          </div>
        </Card>
      )}
      <ErrorAlert error={action.error} />
    </>
  )
}

/** The trigger stays above the form, so opening it only moves content below. */
function StartSection(props: StImportSectionProps) {
  const jobs = useAtomValue(stImportsAtom)
  const hasJobs = AsyncResult.isSuccess(jobs) && jobs.value.length > 0
  const [expanded, setExpanded] = useState(false)
  // Opened by "Check again" in a report too, until it's closed.
  const open = !hasJobs || expanded || props.again !== null
  const top = useRef<HTMLElement>(null)
  useEffect(() => {
    if (props.again !== null) top.current?.scrollIntoView({ block: "start" })
  }, [props.again])
  const collapse = () => {
    setExpanded(false)
    if (props.again !== null) props.open(props.opened)
  }
  if (!AsyncResult.isSuccess(jobs)) return null
  return (
    <section ref={top} className="flex scroll-mt-4 flex-col gap-3">
      <h2 className="text-base font-semibold">Start another import</h2>
      {hasJobs && (
        <Button
          aria-expanded={open}
          aria-pressed={open}
          className="self-start"
          hint="Opens the ST folder import form."
          onClick={() => (open ? collapse() : setExpanded(true))}
        >
          Import ST data again
        </Button>
      )}
      {open && (
        <div className="flex flex-col gap-4">
          <StartForm
            {...props}
            close={hasJobs ? collapse : null}
            open={(id) => {
              setExpanded(false)
              props.open(id)
            }}
          />
        </div>
      )}
    </section>
  )
}

// --- The single history list and its removal controls.
function JobsSection({ opened, open }: StImportSectionProps) {
  const action = useAction()
  return (
    <AsyncView atom={stImportsAtom} loading="Loading your imports…">
      {(jobs) => (
        <Card>
          <CardHeader
            title="History"
            actions={
              <Button
                variant="ghost"
                pending={action.pending}
                disabled={!jobs.some((job) => job.status !== "running")}
                hint="Removes finished imports and their reports from history."
                onClick={async () => {
                  const cleared = await action.run(
                    (client) => client("ClearStImports", { importId: null }),
                    [ST_IMPORTS]
                  )
                  if (cleared.ok) open(null)
                }}
              >
                Clear finished imports
              </Button>
            }
          />
          {jobs.length === 0 ? (
            <p className="text-sm text-muted">No imports yet.</p>
          ) : (
            <ul aria-label="History" className="flex flex-col divide-y divide-border">
              {jobs.map((job) => (
                <li key={job.id} className="flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <Tooltip label="Opens this import’s result and report.">
                    <Link
                      to="/import/st"
                      search={{ job: job.id }}
                      aria-current={job.id === (opened ?? jobs[0]?.id) ? "page" : undefined}
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-md text-sm outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span>{when(job.startedAt)}</span>
                      <Badge tone={STATUS_TONES[job.status]}>{STATUS_LABELS[job.status]}</Badge>
                      <span className="text-muted">{countsLine(job)}</span>
                    </Link>
                  </Tooltip>
                  <Menu
                    trigger={
                      <Button
                        hint="Opens actions for this folder import."
                        variant="ghost"
                        className="h-8! w-8 px-0!"
                        aria-label={`Import actions: ${when(job.startedAt)}`}
                      >
                        ⋯
                      </Button>
                    }
                    hint="Opens this import’s history actions."
                    align="end"
                  >
                    <MenuItem
                      disabled={job.status === "running" || action.pending}
                      description="Removes this import and its report from history."
                      onClick={async () => {
                        const cleared = await action.run(
                          (client) => client("ClearStImports", { importId: job.id }),
                          [ST_IMPORTS]
                        )
                        if (cleared.ok && job.id === opened) open(null)
                      }}
                    >
                      Remove from history
                    </MenuItem>
                  </Menu>
                </li>
              ))}
            </ul>
          )}
          <ErrorAlert error={action.error} />
        </Card>
      )}
    </AsyncView>
  )
}

export const stImportSectionEntries = [
  { id: "st-import.job", order: 10, component: JobSection },
  { id: "st-import.start", order: 30, component: StartSection },
  { id: "st-import.jobs", order: 20, component: JobsSection }
] as const

export function StImportPage() {
  useTitle("Import ST data")
  const navigate = useNavigate()
  const search: { job?: unknown; again?: unknown } = useSearch({ strict: false })
  const opened = typeof search.job === "string" && search.job !== "" ? search.job : null
  const again = typeof search.again === "string" && search.again !== "" ? search.again : null
  const open = (importId: string | null) =>
    void navigate({ to: "/import/st", search: importId === null ? {} : { job: importId } })
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <CenterHeaderContent>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Import ST data</h1>
          <Tooltip label="Opens the other import options.">
            <Link to="/import" className={buttonClass("ghost")}>
              Back to Import
            </Link>
          </Tooltip>
        </header>
      </CenterHeaderContent>
      <SlotOutlet slot={stImportSections} props={{ opened, open, again }} />
    </div>
  )
}
