// Importing a SillyTavern data folder (DESIGN §1.4, ARCHITECTURE.md §13): name the folder's
// path (or pick it in the browser, from another machine), choose whose it is in ST's
// multi-user layout, import its files, then read the report and
// act on it: un-hide a summarized run, pick the card of a chat the import couldn't link.
// Report text quotes files, so it's rendered as text.
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import type { EntityId } from "@rp/shared/chat.ts"
import type { StHiddenRun, StImportReport, StLinkChoice } from "@rp/shared/stImportApi.ts"
import type { StRoot } from "@rp/shared/stFolder.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useContext, useRef, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { sessionAtom } from "../../session.ts"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { FileDrop } from "../../ui/FileDrop.tsx"
import { Select } from "../../ui/Select.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Alert, Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { libraryAtom } from "./data.ts"
import {
  orderBranches,
  pathFiles,
  pickedFiles,
  type ReadPart,
  sendStFile,
  type StExtra,
  type StFolderFile,
  type StFound,
  stPlan,
  stRoots
} from "./stUpload.ts"

const KINDS: ReadonlyArray<readonly [string, string]> = [
  ["card", "Cards"],
  ["persona", "Personas"],
  ["lorebook", "Lorebooks"],
  ["preset", "Presets"],
  ["chat", "Chats"],
  ["group_chat", "Group chats"]
]

const OUTCOMES = ["added", "updated", "unchanged", "skipped", "failed"] as const

const TONES = { info: "neutral", warning: "warning", error: "danger" } as const

/** "1 chat", "2 chats". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

interface Progress {
  readonly file: string
  readonly done: number
  readonly total: number
  readonly bytes: number
  readonly totalBytes: number
}

function Counts({ report }: { report: StImportReport }) {
  const rows = KINDS.filter(([kind]) => report.counts[kind] !== undefined)
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Imported" className="flex flex-col gap-1.5 text-sm">
        {rows.map(([kind, label]) => {
          const count = report.counts[kind]!
          return (
            <li key={kind}>
              <span className="font-medium">{label}:</span>{" "}
              <span className="text-muted">
                {OUTCOMES.filter((outcome) => count[outcome] > 0)
                  .map((outcome) => `${count[outcome]} ${outcome}`)
                  .join(", ")}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="text-sm text-muted">
        {count(report.messages, "message")} read, {count(report.summaries, "summary", "summaries")} kept.{" "}
        {count(report.greetingOnly, "chat")} with only a greeting skipped.
      </p>
      {report.unsupported.length > 0 && (
        <p className="text-sm text-muted">
          Not imported, since this app only does chat completion:{" "}
          {report.unsupported.map((u) => `${u.count} ${u.what}${u.count === 1 ? "" : "s"}`).join(", ")}.
        </p>
      )}
    </div>
  )
}

function LinkChoiceRow({
  choice,
  onChoose
}: {
  choice: StLinkChoice
  onChoose: (card: string) => Promise<string | null>
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
    { value: "none", label: "No card" }
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
          disabled={card === null || pending}
          onClick={async () => {
            setPending(true)
            setError(await onChoose(card!))
            setPending(false)
          }}
        >
          {pending && <Spinner />}
          Import with this card
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  )
}

function ReportView({
  report,
  onUnhide,
  onChoose
}: {
  report: StImportReport
  onUnhide: (run: StHiddenRun) => void
  onChoose: (path: string, card: string) => Promise<string | null>
}) {
  return (
    <>
      <Card>
        <CardHeader title="Report" />
        <Counts report={report} />
      </Card>
      {report.links.length > 0 && (
        <Card>
          <CardHeader
            title="Chats to link"
            description="The import couldn't tell which card these chats are with. Choose one and they're imported with it."
          />
          <ul aria-label="Chats to link" className="flex flex-col divide-y divide-border">
            {report.links.map((choice) => (
              <LinkChoiceRow key={choice.path} choice={choice} onChoose={(card) => onChoose(choice.path, card)} />
            ))}
          </ul>
        </Card>
      )}
      {report.hiddenRuns.length > 0 && (
        <Card>
          <CardHeader
            title="Hidden from the start"
            description="These chats have messages hidden from their first message on, as ST's manual summarizing leaves them. They stay hidden unless you un-hide them."
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
                    {run.title}
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
                <Button onClick={() => onUnhide(run)}>Un-hide</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {report.issues.length > 0 && (
        <Card>
          <CardHeader title="Notes on the files" />
          <ul
            aria-label="Notes on the files"
            className="flex max-h-96 flex-col gap-1.5 overflow-y-auto rounded-md border border-border bg-canvas p-2 text-sm"
          >
            {report.issues.map((issue, index) => (
              <li key={index} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <Badge tone={TONES[issue.level]}>{issue.level}</Badge>
                <span className="min-w-0 font-mono text-xs text-muted [overflow-wrap:anywhere]">{issue.path}</span>
                <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{issue.message}</span>
              </li>
            ))}
          </ul>
          {report.dropped > 0 && <p className="mt-2 text-sm text-muted">{report.dropped} more aren't listed.</p>}
        </Card>
      )}
    </>
  )
}

export function StImportPage() {
  useTitle("Import ST data")
  const registry = useContext(RegistryContext)
  const action = useAction()
  // Each file's import reports its own failure in the list below, not as the page's error.
  const fileAction = useAction()
  const [folderPath, setFolderPath] = useState("")
  const [files, setFiles] = useState<ReadonlyArray<StFound> | null>(null)
  const [roots, setRoots] = useState<ReadonlyArray<StRoot>>([])
  const [prefix, setPrefix] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [report, setReport] = useState<StImportReport | null>(null)
  const [failures, setFailures] = useState<ReadonlyArray<{ path: string; message: string }>>([])
  // What a choice of card sends again: the import, and its files by path.
  const sent = useRef<{ importId: string; byPath: Map<string, StFolderFile> } | null>(null)
  const running = progress !== null

  const choose = (found: ReadonlyArray<StFound>) => {
    const users = stRoots(found)
    setFiles(found)
    setRoots(users)
    setPrefix(users.length === 1 ? users[0]!.prefix : null)
    setReport(null)
    setFailures([])
  }

  const scan = async () => {
    const scanned = await action.run((client) => client("ScanStFolder", { path: folderPath.trim() }))
    if (scanned.ok) choose(pathFiles(scanned.value.root, scanned.value.files))
  }

  const readPart: ReadPart = async (request) => {
    const read = await fileAction.run((client) => client("ImportStFolderFile", request), ["library"])
    if (read.ok) return { _tag: "Done", result: read.value }
    return read.error.tag === "Unauthorized"
      ? { _tag: "Unauthorized" }
      : { _tag: "Failed", message: read.error.message }
  }

  const plan = prefix === null || files === null ? null : stPlan(files, prefix)

  const refreshReport = async (importId: string) => {
    const read = await action.run((client) => client("GetStImportReport", { importId }), ["library"])
    if (read.ok) setReport(read.value)
  }

  const runImport = async () => {
    if (plan === null) return
    // Parents before their branches, so a branch is rarely sent twice.
    const files = await orderBranches(plan.send)
    const started = await action.run((client) => client("StartStImport", { unsupported: plan.unsupported }))
    if (!started.ok) return
    const { importId } = started.value
    sent.current = { importId, byPath: new Map(files.map((entry) => [entry.path, entry])) }
    const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0)
    const lost: Array<{ path: string; message: string }> = []
    let bytesBefore = 0
    let done = 0
    const send = async (entry: StFolderFile, extra: StExtra) => {
      setProgress({ file: entry.path, done, total: files.length, bytes: bytesBefore, totalBytes })
      let answer = await sendStFile(
        importId,
        entry,
        extra,
        (bytes) => setProgress({ file: entry.path, done, total: files.length, bytes: bytesBefore + bytes, totalBytes }),
        readPart
      )
      // The server lost the chat's earlier parts (it restarted): once more from the start.
      if (answer._tag === "Done" && answer.result.outcome === "restart") {
        answer = await sendStFile(importId, entry, extra, () => {}, readPart)
      }
      return answer
    }
    let deferred: Array<StFolderFile> = []
    const sendAll = async (entries: ReadonlyArray<StFolderFile>, extra: StExtra) => {
      for (const entry of entries) {
        const answer = await send(entry, extra)
        if (answer._tag === "Unauthorized") {
          registry.refresh(sessionAtom)
          return false
        }
        if (answer._tag === "Failed") lost.push({ path: entry.path, message: answer.message })
        if (answer._tag === "Done" && answer.result.outcome === "deferred") deferred.push(entry)
        else {
          bytesBefore += entry.size
          done++
        }
      }
      return true
    }
    let going = await sendAll(files, {})
    // Branches whose parent wasn't in yet, again until nothing more goes in, then on their own.
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
    setProgress(null)
    setFailures(lost)
    if (going) await refreshReport(importId)
  }

  const link = async (path: string, card: string) => {
    const current = sent.current
    const entry = current?.byPath.get(path)
    if (!current || !entry) return "Choose the folder again to import this chat."
    // The report's candidates are the user's cards, or "none".
    const answer = await sendStFile(current.importId, entry, { card: card as EntityId | "none" }, () => {}, readPart)
    if (answer._tag === "Unauthorized") {
      registry.refresh(sessionAtom)
      return "Your session has ended."
    }
    if (answer._tag === "Failed") return answer.message
    if (answer.result.outcome === "failed") return answer.result.message || "The chat couldn't be imported."
    await refreshReport(current.importId)
    return null
  }

  const unhide = async ({ chatId, throughSlotId }: StHiddenRun) => {
    const current = sent.current
    const done = await action.run((client) => client("UnhideImportedRun", { chatId, throughSlotId }))
    if (done.ok && current) await refreshReport(current.importId)
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Import ST data</h1>
        <Link to="/import" className={buttonClass("ghost")}>
          Back to importing files
        </Link>
      </header>
      <Card>
        <CardHeader
          title="SillyTavern data folder"
          description="ST's data folder, ST itself, or one user's folder inside data. Its cards, personas, lorebooks, chat-completion presets, groups and chats are imported; nothing else is read. Importing the same folder again adds only what's new."
        />
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
              disabled={running}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            className="justify-self-start"
            disabled={running || folderPath.trim() === "" || action.pending}
          >
            Look in this folder
          </Button>
        </form>
        <p className="mt-4 mb-2 text-sm text-muted">
          Using a browser on another computer, where the folder is? Choose it here instead, and it's sent from this
          browser.
        </p>
        <FileDrop
          label="Choose the folder"
          description={running ? "Wait until this import is done." : "Your browser asks before it shares the folder."}
          directory
          disabled={running}
          onFiles={(picked) => choose(pickedFiles(picked))}
        />
      </Card>
      {files !== null && roots.length === 0 && (
        <Alert tone="warning" title="No SillyTavern data here">
          <p>This folder has no characters, chats or settings in ST's layout. Choose ST's data folder.</p>
        </Alert>
      )}
      {roots.length > 0 && !running && report === null && (
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
              <p className="text-sm text-muted">
                {plan.send.length} files to import ({megabytes(plan.send.reduce((sum, f) => sum + f.size, 0))})
                {plan.unsupported.length > 0 && `, ${plan.unsupported.length} that only text completion uses`}.
              </p>
            )}
            <div>
              <Button
                variant="primary"
                disabled={plan === null || plan.send.length === 0}
                onClick={() => void runImport()}
              >
                Import
              </Button>
            </div>
          </div>
        </Card>
      )}
      {progress && (
        <Card>
          <div role="status" className="flex flex-col gap-2 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <Spinner />
              Importing, {progress.done} of {progress.total} files…
            </span>
            <span className="text-muted [overflow-wrap:anywhere]">{progress.file}</span>
            <progress
              className="h-2 w-full accent-accent"
              max={Math.max(1, progress.totalBytes)}
              value={progress.bytes}
              aria-label="Sent"
            />
            <span className="text-muted">
              {megabytes(progress.bytes)} of {megabytes(progress.totalBytes)}
            </span>
          </div>
        </Card>
      )}
      <ErrorAlert error={action.error} />
      {failures.length > 0 && (
        <Alert tone="danger" title="Not sent">
          <ul className="list-disc pl-5">
            {failures.map((failure) => (
              <li key={failure.path} className="[overflow-wrap:anywhere]">
                {failure.path}: {failure.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {report && <ReportView report={report} onUnhide={(run) => void unhide(run)} onChoose={link} />}
    </div>
  )
}
