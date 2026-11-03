// Importing a SillyTavern data folder (DESIGN §1.4, ARCHITECTURE.md §13). The page lists the
// user's imports, running and past, each opening to its report, and starts one: a folder
// named by its path is imported by the server as a job that goes on whatever this tab does;
// one picked in the browser (from another machine) is sent from this tab, file by file, and
// its job records the files as they arrive. Its sections are registered parts
// (`stImportSections`), so a plugin can replace or remove one. Report text quotes files, so
// it's rendered as text.
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import type { EntityId } from "@rp/shared/chat.ts"
import type { StRoot } from "@rp/shared/stFolder.ts"
import type {
  StFolderEntry,
  StHiddenRun,
  StImportedChat,
  StImportJob,
  StImportJobDetail,
  StImportReport,
  StLinkChoice,
  StNotSent
} from "@rp/shared/stImportApi.ts"
import { type StSentKind, stPlan, stPlanKinds } from "@rp/shared/stPlan.ts"
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
import { formatByteSize } from "@rp/shared/byteSize.ts"
import { FileDrop } from "../../ui/FileDrop.tsx"
import { Select } from "../../ui/Select.tsx"
import { ProgressBar, Spinner } from "../../ui/Spinner.tsx"
import { Alert, Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { readableChatTitle } from "../chat/chatTitle.ts"
import { NeedsAttention } from "./stImportIssues.tsx"
import { useTitle } from "../shell.tsx"
import { libraryAtom } from "./data.ts"
import { FolderBrowser } from "./FolderBrowser.tsx"
import { type StImportSectionProps, stImportSections } from "./slots.ts"
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

/** The report's kinds, as `StImportReport.counts` names them. */
const KINDS: ReadonlyArray<readonly [string, string]> = [
  ["card", "Cards"],
  ["persona", "Personas"],
  ["chat", "Chats"],
  ["group_chat", "Group chats"],
  ["group", "Groups"],
  ["character_note", "Character author's notes"],
  ["lorebook", "Lorebooks"],
  ["preset", "Presets"]
]

/** The preview's kinds, as the folder's files are found (`stPlan`). */
const FOLDER_KINDS: ReadonlyArray<readonly [StSentKind, string]> = [
  ["card", "Cards"],
  ["persona_avatar", "Personas"],
  ["chat", "Chats"],
  ["group_chat", "Group chats"],
  ["group", "Groups"],
  ["world", "Lorebooks"],
  ["preset", "Presets"],
  ["settings", "Settings"]
]

const OUTCOMES = ["added", "updated", "failed"] as const

/** How the report words each outcome; `unchanged` for a group is a group read for its chats. */
const OUTCOME_WORDS = { added: "added", updated: "updated", unchanged: "already here", failed: "failed" }
// Not `skipped`: the report holds only what the user must act on (DESIGN §1.4), and skipped
// chats hold only a greeting.
const SHOWN_OUTCOMES = ["added", "updated", "unchanged", "failed"] as const

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
  let deferred: Array<StFolderFile> = []
  const send = async (entry: StFolderFile, extra: StExtra) => {
    const answer = await sendStFile(importId, entry, extra, () => {})
    // The server lost the chat's earlier parts (it restarted): once more from the start.
    return answer._tag === "Done" && answer.result.outcome === "restart"
      ? sendStFile(importId, entry, extra, () => {})
      : answer
  }
  const sendAll = async (entries: ReadonlyArray<StFolderFile>, extra: StExtra) => {
    for (const entry of entries) {
      if (stoppedUploads.has(importId)) return false
      const answer = await send(entry, extra)
      if (answer._tag === "Unauthorized") {
        registry.refresh(sessionAtom)
        return false
      }
      // Cancelled, or another import started: the server takes no more of it.
      if (answer._tag === "Gone") return false
      if (answer._tag === "Failed") lost.push({ path: entry.path, message: answer.message })
      if (answer._tag === "Done" && answer.result.outcome === "deferred") deferred.push(entry)
    }
    return true
  }
  try {
    let going = await sendAll(files, {})
    while (going && deferred.length > 0) {
      const waiting = deferred
      deferred = []
      going = await sendAll(waiting, {})
      if (going && deferred.length === waiting.length) {
        const orphans = deferred
        deferred = []
        going = await sendAll(orphans, { orphan: true })
      }
    }
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

/** What the import did, in one line per kind: what changed, what was already here, what failed. Details aren't listed. */
function Counts({ report }: { report: StImportReport }) {
  const rows = KINDS.flatMap(([kind, label]) => {
    const count = report.counts[kind]
    const shown = count ? SHOWN_OUTCOMES.filter((outcome) => count[outcome] > 0) : []
    const words = (outcome: (typeof SHOWN_OUTCOMES)[number]) =>
      kind === "group" && outcome === "unchanged" ? "read for their chats" : OUTCOME_WORDS[outcome]
    return count && shown.length ? [{ kind, label, text: shown.map((o) => `${count[o]} ${words(o)}`).join(", ") }] : []
  })
  return rows.length ? (
    <ul aria-label="Imported" className="flex flex-col gap-1.5 text-sm">
      {rows.map(({ kind, label, text }) => (
        <li key={kind}>
          <span className="font-medium">{label}:</span> <span className="text-muted">{text}</span>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-muted">Nothing new or changed to import.</p>
  )
}

/** Where to go once an import is in: the characters, and the newest imported chat. */
function NextSteps({ latestChat }: { latestChat: StImportedChat | null }) {
  return (
    <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
      <Link to="/" className={buttonClass(latestChat ? "secondary" : "primary")}>
        Open your characters
      </Link>
      {latestChat && (
        <Link
          to="/chats/$chatId"
          params={{ chatId: latestChat.chatId }}
          // The chat's name wraps on a phone rather than being cut off.
          className={`${buttonClass("primary")} h-auto! min-h-9 max-w-full py-2 text-left whitespace-normal!`}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {/* As the chat list names it, never ST's file name (DESIGN §2.1). */}
            Continue your latest chat
            {latestChat.title
              ? `: ${readableChatTitle(
                  latestChat.title,
                  latestChat.createdAt ?? null,
                  (latestChat.names ?? []).map((name) => ({ name }))
                )}`
              : ""}
          </span>
        </Link>
      )}
    </div>
  )
}

function LinkChoiceRow({
  choice,
  onChoose
}: {
  choice: StLinkChoice
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
    <li className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{choice.title}</span>
      <span className="text-sm text-muted [overflow-wrap:anywhere]">{choice.reason}</span>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={`Card for ${choice.title}`} className="w-full sm:w-64">
          <Select items={items} value={card} onValueChange={setCard} placeholder="Choose a card" />
        </Field>
        <Button
          disabled={card === null}
          pending={pending}
          hint="Imports this chat now, linked to the card you chose."
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

function NotSentList({ notSent }: { notSent: ReadonlyArray<StNotSent> }) {
  if (notSent.length === 0) return null
  return (
    <Alert tone="danger" title="Not sent">
      <ul className="list-disc pl-5">
        {notSent.map((failure) => (
          <li key={failure.path} className="[overflow-wrap:anywhere]">
            {failure.path}: {failure.message}
          </li>
        ))}
      </ul>
    </Alert>
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
  const unhide = ({ chatId, throughSlotId }: StHiddenRun) =>
    void action.run((client) => client("UnhideImportedRun", { chatId, throughSlotId, importId: job.id }), AFTER_ACTION)
  return (
    <>
      <ErrorAlert error={action.error} />
      {report.links.length > 0 && (
        <Card>
          <CardHeader title="Chats to link" about="Choose a card for chats the import couldn’t match." />
          {linkNote && <p className="mb-3 text-sm text-muted">{linkNote}</p>}
          <ul aria-label="Chats to link" className="flex flex-col divide-y divide-border">
            {report.links.map((choice) => (
              <LinkChoiceRow key={choice.path} choice={choice} onChoose={(card) => choose(choice.path, card)} />
            ))}
          </ul>
        </Card>
      )}
      {report.hiddenRuns.length > 0 && (
        <Card>
          <CardHeader
            title="Hidden from the start"
            about="These chats start with hidden messages, often from manual summarizing in ST. Un-hide them to include them in the context again."
          />
          <ul aria-label="Hidden runs" className="flex flex-col divide-y divide-border">
            {report.hiddenRuns.map((run) => (
              <li
                key={run.chatId}
                className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <Link
                    to="/chats/$chatId"
                    params={{ chatId: run.chatId }}
                    className="font-medium text-accent underline-offset-4 [overflow-wrap:anywhere] hover:underline"
                  >
                    {readableChatTitle(run.title)}
                  </Link>
                  <span className="text-sm text-muted">
                    {run.hidden} messages hidden.{" "}
                    {run.summaryCovers === true
                      ? "Its summary covers them, so un-hiding sends them twice."
                      : run.summaryCovers === false
                        ? "Its summary doesn't cover all of them."
                        : "It has no summary."}
                  </span>
                </div>
                <Button
                  hint="Sends these messages to the model again, from the chat’s first message to the end of the run."
                  onClick={() => unhide(run)}
                >
                  Un-hide
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <NeedsAttention report={report} />
    </>
  )
}

// --- One import

/** Start, end, how long, how many files. */
function JobFacts({ job, now }: { job: StImportJob; now: number }) {
  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Started", when(job.startedAt)],
    ...(job.finishedAt === null ? [] : ([["Ended", when(job.finishedAt)]] as const)),
    [job.finishedAt === null ? "Running for" : "Took", took((job.finishedAt ?? now) - job.startedAt)],
    ["Files", `${job.filesDone} of ${job.filesTotal}`]
  ]
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {facts.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted">{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const useNow = (running: boolean) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

function JobTitle({ job }: { job: StImportJob }) {
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
      <h2 className="min-w-0 font-semibold [overflow-wrap:anywhere]">{job.source}</h2>
      <Badge tone={STATUS_TONES[job.status]}>{STATUS_LABELS[job.status]}</Badge>
    </div>
  )
}

function RunningJob({ job }: { job: StImportJob }) {
  const action = useAction()
  const now = useNow(true)
  const sending = uploads.has(job.id)
  return (
    <Card>
      <JobTitle job={job} />
      <div role="status" className="flex flex-col gap-2 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <Spinner />
          Importing, {job.filesDone} of {job.filesTotal} files · {percentOf(job)}%
        </span>
        {job.currentFile && <span className="text-muted [overflow-wrap:anywhere]">{job.currentFile}</span>}
        <ProgressBar
          className="h-2 w-full"
          max={Math.max(1, job.bytesTotal)}
          value={job.bytesDone}
          label="Imported so far"
        />
        <span className="text-muted">
          {formatByteSize(job.bytesDone)} of {formatByteSize(job.bytesTotal)}
        </span>
      </div>
      <p className="mt-3 text-sm">
        {job.mode === "path"
          ? "You can close this tab. The import keeps going; follow its progress here from any device."
          : sending
            ? "Keep this tab open until the import finishes. You can use other pages of the app."
            : "Its files are sent from the tab that started it. If that tab was closed, the import ends as stopped 10 minutes after its last file arrived."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <JobFacts job={job} now={now} />
      </div>
      <div className="mt-4">
        <Button
          pending={action.pending}
          onClick={() => {
            stoppedUploads.add(job.id)
            void action.run((client) => client("CancelStImport", { importId: job.id }), [ST_IMPORTS])
          }}
        >
          Cancel the import
        </Button>
        <p className="mt-1 text-xs text-muted">Stop after the current file. What’s already imported stays.</p>
      </div>
      <ErrorAlert error={action.error} />
    </Card>
  )
}

function FinishedJob({ job, open }: { job: StImportJob; open: StImportSectionProps["open"] }) {
  const action = useAction()
  const admin = useSession().user.role === "admin"
  const atom = useMemo(
    () => AppClient.query("GetStImport", { importId: job.id }, { reactivityKeys: [ST_IMPORTS] }),
    [job.id]
  )
  // Opened: the app shell stops saying it finished.
  const seen = job.seen
  useEffect(() => {
    if (!seen) void action.run((client) => client("SeenStImport", { importId: job.id }), [ST_IMPORTS])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening, whatever the action's identity
  }, [job.id, seen])
  const again = async () => {
    // The job's folder is the ST user's own folder, so it's its one user.
    const started = await action.run(
      (client) => client("StartStPathImport", { path: job.source, prefix: "" }),
      [ST_IMPORTS]
    )
    if (started.ok) open(started.value.importId)
  }
  const ended = job.status !== "complete"
  return (
    <AsyncView atom={atom} loading="Loading the report…">
      {(detail: StImportJobDetail) => (
        <>
          <Card>
            <JobTitle job={detail.job} />
            <JobFacts job={detail.job} now={detail.job.finishedAt ?? detail.job.updatedAt} />
            {detail.job.error && <p className="mt-3 text-sm text-danger">{detail.job.error}</p>}
            {ended && (
              <p className="mt-3 text-sm text-muted">
                Importing the same folder again goes on from where this one was: what's in stays, and only what's new or
                changed is imported.
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {ended && job.mode === "path" && admin && (
                <Button
                  variant="primary"
                  pending={action.pending}
                  hint="Starts a new import of the same folder, which takes in only what’s new or changed."
                  onClick={() => void again()}
                >
                  Import again
                </Button>
              )}
              <Button
                variant="ghost"
                hint="Forgets this import and its report. Nothing it imported changes."
                onClick={async () => {
                  const cleared = await action.run(
                    (client) => client("ClearStImports", { importId: job.id }),
                    [ST_IMPORTS]
                  )
                  if (cleared.ok) open(null)
                }}
              >
                Remove from the list
              </Button>
            </div>
            {ended && job.mode === "upload" && (
              <p className="mt-3 text-sm text-muted">To import it again, choose the folder again below.</p>
            )}
            <ErrorAlert error={action.error} />
          </Card>
          {detail.report && (
            <Card>
              <CardHeader title="Report" />
              <Counts report={detail.report} />
              <NextSteps latestChat={detail.latestChat} />
            </Card>
          )}
          <NotSentList notSent={detail.notSent} />
          {detail.report && (
            <ReportActions
              job={detail.job}
              report={detail.report}
              linkNote={
                detail.job.mode === "upload" && !uploads.has(detail.job.id)
                  ? "This import's files were sent from a browser: linking a chat needs them again, from the tab that sent them, or by importing the folder again."
                  : null
              }
            />
          )}
        </>
      )}
    </AsyncView>
  )
}

/** The import opened (`?job=`), else the one running. */
function JobSection({ opened, open }: StImportSectionProps) {
  const result = useAtomValue(stImportsAtom)
  const top = useRef<HTMLDivElement>(null)
  // An import opened from the list below shows up here, at the top: on a phone the list is
  // screens further down, so the page goes to it.
  useEffect(() => {
    if (opened !== null) top.current?.scrollIntoView({ block: "start" })
  }, [opened])
  if (!AsyncResult.isSuccess(result)) return <div ref={top} />
  const job =
    opened === null ? result.value.find((j) => j.status === "running") : result.value.find((j) => j.id === opened)
  return (
    <div ref={top} className="flex scroll-mt-4 flex-col gap-6 empty:hidden">
      {job === undefined ? (
        opened !== null && (
          <Alert tone="warning" title="That import isn't in the list">
            <p>It was removed from the list. What it imported is still in your library and chats.</p>
          </Alert>
        )
      ) : job.status === "running" ? (
        <RunningJob job={job} />
      ) : (
        <FinishedJob key={job.id} job={job} open={open} />
      )}
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

function StartSection({ open }: StImportSectionProps) {
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

  const choose = (next: Chosen | null) => {
    const users = next === null ? [] : stRoots(next.files.map((file) => file.path))
    setChosen(next)
    setRoots(users)
    setPrefix(users.length === 1 ? users[0]!.prefix : null)
  }

  const scan = async () => {
    setScanning(true)
    const scanned = await action
      .run((client) => client("ScanStFolder", { path: folderPath.trim() }))
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

  const plan = useMemo(
    () => (prefix === null || chosen === null ? null : stPlan<{ path: string; size: number }>(chosen.files, prefix)),
    [chosen, prefix]
  )

  const runImport = async () => {
    if (chosen === null || prefix === null) return
    setStarting(true)
    try {
      if (chosen._tag === "Path") {
        const started = await action.run(
          (client) => client("StartStPathImport", { path: chosen.root, prefix }),
          [ST_IMPORTS]
        )
        if (!started.ok) return
        choose(null)
        open(started.value.importId)
        return
      }
      const { send, unsupported } = await orderedPlan(chosen.files, prefix)
      const bytes = send.reduce((sum, entry) => sum + entry.size, 0)
      const started = await action.run(
        (client) =>
          client("StartStImport", { unsupported, source: pickedName(chosen.files, prefix), files: send.length, bytes }),
        [ST_IMPORTS]
      )
      if (!started.ok) return
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
          about="Import characters, personas, lorebooks, chat-completion presets, groups and chats from a SillyTavern folder. Choose the installation, data folder or one user’s folder. Re-import to add new and changed content."
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
                hint="Lists what’s in it and how much is new. Nothing is imported yet."
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
            <p className="mt-4 mb-2 text-sm text-muted">
              Using a browser on another computer, where the folder is? Choose it here instead, and it's sent from this
              browser.
            </p>
          </>
        )}
        <FileDrop
          label="Choose the folder"
          description="Your browser asks before it shares the folder. Its files are sent from this tab, which stays open until they're all in."
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
            {chosen?._tag === "Path" ? (
              <p className="text-sm text-muted">You can close this tab after starting the import.</p>
            ) : (
              <p className="text-sm text-muted">Keep this tab open until the import finishes.</p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={plan === null || plan.send.length === 0 || running}
                pending={starting}
                hint="Adds what’s new, and takes in what changed since an earlier import."
                onClick={() => void runImport()}
              >
                Import
              </Button>
              {running && (
                <span className="text-sm text-muted">
                  One import at a time: this one can start when the running one is done.
                </span>
              )}
            </div>
          </div>
        </Card>
      )}
      <ErrorAlert error={action.error} />
    </>
  )
}

// --- The list

function JobsSection({ opened }: StImportSectionProps) {
  const action = useAction()
  const navigate = useNavigate()
  return (
    <AsyncView atom={stImportsAtom} loading="Loading your imports…">
      {(jobs) => (
        <Card>
          <CardHeader title="Imports" about="Removing an import from the list changes nothing it imported." />
          {jobs.length === 0 ? (
            <p className="text-sm text-muted">No imports yet.</p>
          ) : (
            <ul aria-label="Imports" className="-mx-2 flex flex-col">
              {jobs.map((job) => (
                <li key={job.id}>
                  <Link
                    to="/import/st"
                    search={{ job: job.id }}
                    aria-current={job.id === opened ? "page" : undefined}
                    className="flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 text-sm hover:bg-surface-raised aria-[current=page]:bg-surface-raised"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{job.source}</span>
                      <Badge tone={STATUS_TONES[job.status]}>
                        {job.status === "running"
                          ? `${STATUS_LABELS.running} · ${percentOf(job)}%`
                          : STATUS_LABELS[job.status]}
                      </Badge>
                      {job.attention > 0 && <Badge tone="warning">{job.attention} to look at</Badge>}
                    </span>
                    <span className="text-muted">
                      {when(job.startedAt)}
                      {job.finishedAt !== null && ` · took ${took(job.finishedAt - job.startedAt)}`} · {job.filesDone}{" "}
                      of {job.filesTotal} files · {countsLine(job)}
                    </span>
                    {/* Why it stopped, without opening it; opened, it offers to import again. */}
                    {job.error && <span className="text-danger [overflow-wrap:anywhere]">{job.error}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {jobs.some((job) => job.status !== "running") && (
            <div className="mt-3">
              <Button
                variant="ghost"
                pending={action.pending}
                hint="Forgets every finished import and its report. Nothing they imported changes."
                onClick={async () => {
                  const cleared = await action.run(
                    (client) => client("ClearStImports", { importId: null }),
                    [ST_IMPORTS]
                  )
                  if (cleared.ok && opened !== null) void navigate({ to: "/import/st", search: {} })
                }}
              >
                Clear finished imports
              </Button>
            </div>
          )}
          <ErrorAlert error={action.error} />
        </Card>
      )}
    </AsyncView>
  )
}

export const stImportSectionEntries = [
  { id: "st-import.job", order: 10, component: JobSection },
  { id: "st-import.start", order: 20, component: StartSection },
  { id: "st-import.jobs", order: 30, component: JobsSection }
] as const

export function StImportPage() {
  useTitle("Import ST data")
  const navigate = useNavigate()
  const search: { job?: unknown } = useSearch({ strict: false })
  const opened = typeof search.job === "string" && search.job !== "" ? search.job : null
  const open = (importId: string | null) =>
    void navigate({ to: "/import/st", search: importId === null ? {} : { job: importId } })
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Import ST data</h1>
        <Link to="/import" className={buttonClass("ghost")}>
          Back to Import
        </Link>
      </header>
      <SlotOutlet slot={stImportSections} props={{ opened, open }} />
    </div>
  )
}
