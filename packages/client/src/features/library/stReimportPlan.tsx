// The re-import preview (ARCHITECTURE.md §13 "Re-import preview"): before an ST folder import
// writes anything, what it would do to the chats already here, file by file, worked out on
// the server by the import's own matcher with nothing written (StImportPlans). The user can
// skip files; the import they then start is held to this preview, and refused if the chats
// changed since (`StImportPlanChanged`), which the import form answers by checking again.
// Every text here that comes from a file or a chat is rendered as text.
import { RegistryContext } from "@effect/atom-react"
import type { StPlanChoice } from "@rp/shared/stImportApi.ts"
import {
  type StImportPlan,
  type StPlanCounts,
  type StPlanFile,
  type StPlanMessage,
  stPlanAffectedBySkip,
  PLAN_MESSAGES_PAGE
} from "@rp/shared/stReimportPlan.ts"
import { Link } from "@tanstack/react-router"
import { Context, Effect, Exit } from "effect"
import { AtomRegistry } from "effect/reactivity"
import { useContext, useEffect, useMemo, useRef, useState } from "react"
import { describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { ProgressBar } from "../../ui/Spinner.tsx"
import { Alert, Disclosure } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { readableChatTitle } from "../chat/chatTitle.ts"
import { orderedPlan, sendStPlanFile, type StFound } from "./stUpload.ts"

/** The folder the preview reads: one the server reads by its path, or one picked in this tab. */
export type PlanSource =
  | { readonly _tag: "Path"; readonly root: string; readonly prefix: string }
  | { readonly _tag: "Picked"; readonly found: ReadonlyArray<StFound>; readonly prefix: string }

/** How often a running preview is read again. */
const POLL_MS = 400
/** Files listed before "Show all". */
const FILES_SHOWN = 50

const call = <A, E>(registry: AtomRegistry.AtomRegistry, run: (client: AppClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(
    Effect.flatMap(AtomRegistry.getResult(registry, AppClient.runtime), (services) =>
      run(Context.get(services, AppClient))
    )
  )

const fileName = (path: string) => (path.split("/").at(-1) ?? path).replace(/\.jsonl$/i, "")

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** A file's counts in one line, only what it changes. */
const countsLine = (counts: StPlanCounts) => {
  const parts = [
    counts.newMessages > 0 && plural(counts.newMessages, "new message", "new messages"),
    counts.branches > 0 && plural(counts.branches, "new branch", "new branches"),
    counts.newSwipes > 0 && plural(counts.newSwipes, "new swipe", "new swipes"),
    counts.selected > 0 && plural(counts.selected, "shown swipe changes", "shown swipes change"),
    counts.kept > 0 &&
      `${plural(counts.kept, "message", "messages")} kept as you left ${counts.kept === 1 ? "it" : "them"}`
  ].filter((part): part is string => part !== false)
  return parts.length > 0 ? parts.join(" · ") : "Nothing new"
}

const changes = (counts: StPlanCounts) => counts.newMessages + counts.newSwipes + counts.selected + counts.branches > 0

/** Every importable file can be skipped, including one made quiet by an earlier file. */
const choosable = (file: StPlanFile) =>
  file.status === "done" && (file.target === "existing" || file.target === "unfinished" || file.target === "branch")

const why = (file: StPlanFile) => {
  switch (file.target) {
    case "existing":
      return "Imported before."
    case "unfinished":
      return "An earlier import of it stopped part way; this one finishes it."
    case "branch":
      return `A new branch of ${file.parentPath === null ? "a chat here" : fileName(file.parentPath)}.`
    case "bin":
      return "Its chat is in the recycle bin, so it's skipped."
    case "greeting":
      return "It holds only a greeting, so it's skipped."
    case "failed":
      return "It couldn't be read."
  }
}

const CHANGE_LABELS: Record<StPlanMessage["change"], string> = {
  new: "New",
  branch: "New branch",
  swipes: "New swipes",
  selected: "Shown swipe changes",
  kept: "Kept"
}

const KEPT_LABELS: Record<NonNullable<StPlanMessage["kept"]>, string> = {
  choice: "you chose or edited another swipe here",
  hidden: "you hid or showed it here",
  deleted: "you deleted it here"
}

function MessageRows({ planId, path, total }: { planId: string; path: string; total: number }) {
  const registry = useContext(RegistryContext)
  const [messages, setMessages] = useState<ReadonlyArray<StPlanMessage>>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const page = (offset: number) =>
    call(registry, (client) => client("GetStImportPlanMessages", { planId, path, offset })).then((read) => {
      if (Exit.isFailure(read)) return setFailed(true)
      setMessages((shown) => [...shown.slice(0, offset), ...read.value.messages])
    })
  const load = async (offset: number) => {
    setLoading(true)
    await page(offset)
    setLoading(false)
  }
  // The first page once opened; "Show more" reads the next.
  useEffect(() => {
    void page(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, path])
  if (failed) return <p className="text-sm text-muted">The messages couldn't be read. Check the folder again.</p>
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label={`Changed messages in ${fileName(path)}`} className="flex flex-col divide-y divide-border">
        {messages.map((message) => (
          <li key={message.index} className="flex min-w-0 flex-col gap-0.5 py-1.5 text-sm">
            <span className="text-muted">
              {`Message ${message.index + 1} · ${message.user ? "yours" : "reply"} · `}
              {message.change === "swipes"
                ? plural(message.swipes, "new swipe", "new swipes")
                : message.change === "kept" && message.kept !== null
                  ? `Kept: ${KEPT_LABELS[message.kept]}`
                  : CHANGE_LABELS[message.change]}
            </span>
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{message.text}</span>
          </li>
        ))}
      </ol>
      {messages.length < total && (
        <Button
          className="self-start"
          pending={loading}
          hint={`Lists the next ${PLAN_MESSAGES_PAGE} changed messages.`}
          onClick={() => void load(messages.length)}
        >
          Show more
        </Button>
      )}
    </div>
  )
}

function FileRow({
  plan,
  file,
  skipped,
  uncertain,
  onSkip
}: {
  plan: StImportPlan
  file: StPlanFile
  skipped: boolean
  uncertain: boolean
  onSkip: (skip: boolean) => void
}) {
  const detail = file.messages + file.moreMessages
  const name = fileName(file.path)
  const title = readableChatTitle(file.chatTitle)
  const link = (text: string) =>
    file.chatId === null || file.target === "bin" ? (
      <span className="font-medium [overflow-wrap:anywhere]">{text}</span>
    ) : (
      <Tooltip label="Opens this chat as it is now.">
        <Link
          to="/chats/$chatId"
          params={{ chatId: file.chatId }}
          className="font-medium text-accent underline-offset-4 [overflow-wrap:anywhere] hover:underline"
        >
          {text}
        </Link>
      </Tooltip>
    )
  return (
    <li className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm">
            {title === name || file.chatId === null || file.target === "bin" ? (
              link(name)
            ) : (
              <>
                <span className="font-medium [overflow-wrap:anywhere]">{name}</span>
                <span className="text-muted">{" into "}</span>
                {link(title)}
              </>
            )}
          </p>
          <p className="text-sm text-muted">{file.target === "failed" && file.error ? file.error : why(file)}</p>
          {file.status === "done" && file.target !== "bin" && file.target !== "greeting" && !uncertain && (
            <p className="text-sm">{countsLine(file.counts)}</p>
          )}
          {uncertain && (
            <p className="text-sm text-muted">
              An earlier file for this chat is skipped. Its message counts and changes cannot be predicted here.
            </p>
          )}
          {file.status === "failed" && file.target !== "failed" && (
            <p className="text-sm text-danger">{file.error ?? "This chat couldn't be checked."}</p>
          )}
          {!uncertain && file.keepsTip && file.status === "done" && (
            <p className="text-sm text-muted">
              You went on in this chat since: you stay on your messages, and the new ones go on a branch beside them.
            </p>
          )}
        </div>
        {choosable(file) && (
          <Segmented
            label={`Include ${fileName(file.path)}`}
            className="self-start"
            options={[
              { value: "import", label: "Include", description: "Imports this file's changes." },
              { value: "skip", label: "Skip", description: "Leaves this chat as it is." }
            ]}
            value={skipped ? "skip" : "import"}
            onValueChange={(value) => onSkip(value === "skip")}
          />
        )}
      </div>
      {!uncertain && detail > 0 && file.status === "done" && (
        <Disclosure
          lazy
          title={plural(detail, "changed message", "changed messages")}
          hint="Lists what importing does to each message."
        >
          <MessageRows planId={plan.planId} path={file.path} total={file.messages} />
          {file.moreMessages > 0 && (
            <p className="text-sm text-muted">
              {`${plural(file.moreMessages, "more changed message isn't", "more changed messages aren't")} listed.`}
            </p>
          )}
        </Disclosure>
      )}
    </li>
  )
}

/**
 * The preview of the folder's chats already here. `round` changes to check again (after the
 * import was refused); `onChoice` gets the choice once the check is done, else null.
 */
export function ReimportPlan({
  source,
  round,
  onChoice
}: {
  source: PlanSource
  round: number
  onChoice: (choice: StPlanChoice | null) => void
}) {
  const [again, setAgain] = useState(0)
  const key = source._tag === "Path" ? `${source.root}\n${source.prefix}` : source.prefix
  // A new folder, round or "Check again" starts a new check from nothing.
  return (
    <PlanCheck
      key={`${key}\n${round}\n${again}`}
      source={source}
      onChoice={onChoice}
      checkAgain={() => setAgain(again + 1)}
    />
  )
}

function PlanCheck({
  source,
  onChoice,
  checkAgain
}: {
  source: PlanSource
  onChoice: (choice: StPlanChoice | null) => void
  checkAgain: () => void
}) {
  const registry = useContext(RegistryContext)
  const [plan, setPlan] = useState<StImportPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [skip, setSkip] = useState<ReadonlySet<string>>(new Set())
  const [filesShown, setFilesShown] = useState(FILES_SHOWN)
  const sourceRef = useRef(source)

  useEffect(() => {
    const source = sourceRef.current
    let live = true
    let planId: string | null = null
    const fail = (message: string) => {
      if (live) setError(message)
    }
    const run = async () => {
      let sends: ReadonlyArray<Parameters<typeof sendStPlanFile>[1]> = []
      let started
      if (source._tag === "Path") {
        started = await call(registry, (client) =>
          client("StartStImportPlan", { folder: { root: source.root, prefix: source.prefix } })
        )
      } else {
        const ordered = await orderedPlan(source.found, source.prefix)
        const chats = ordered.send.filter((entry) => entry.kind === "chat" || entry.kind === "group_chat")
        sends = chats
        started = await call(registry, (client) =>
          client("StartStImportPlan", {
            files: chats.map((entry) => ({
              path: entry.path,
              size: entry.size,
              modifiedMs: entry.item.file.lastModified,
              mainChat: ordered.mainChats.get(entry.path) ?? null
            }))
          })
        )
      }
      if (!live) {
        if (Exit.isSuccess(started))
          await call(registry, (client) => client("CancelStImportPlan", { planId: started.value.plan.planId }))
        return
      }
      if (Exit.isFailure(started)) return fail(describeCause(started.cause).message)
      planId = started.value.plan.planId
      setPlan(started.value.plan)
      const id = planId
      // A picked folder's files the preview needs, one after another, in the order it asks:
      // the import's, with a branch after the files it's mapped by.
      const byPath = new Map(sends.map((entry) => [entry.path, entry]))
      for (const path of started.value.wanted) {
        if (!live) return
        const entry = byPath.get(path)
        if (entry === undefined) return fail("The check asked for a file that isn't in the folder.")
        let answer = await sendStPlanFile(id, entry, () => {})
        if (answer._tag === "Done" && answer.result.outcome === "restart")
          answer = await sendStPlanFile(id, entry, () => {})
        // Cancelled or replaced: the server takes no more of it.
        if (answer._tag === "Gone" || answer._tag === "Unauthorized") break
        if (answer._tag === "Failed") return fail(answer.message)
      }
    }
    void run()
    const poll = window.setInterval(() => {
      if (planId === null) return
      const id = planId
      void call(registry, (client) => client("GetStImportPlan", { planId: id })).then((read) => {
        if (!live) return
        if (Exit.isFailure(read)) return fail("This check has expired. Check the folder again.")
        setPlan(read.value)
        if (read.value.status !== "running") window.clearInterval(poll)
      })
    }, POLL_MS)
    return () => {
      live = false
      window.clearInterval(poll)
      // Leaving, or choosing another folder: the server stops working it out.
      if (planId !== null) {
        const id = planId
        void call(registry, (client) => client("CancelStImportPlan", { planId: id }))
      }
    }
  }, [registry])

  const done = plan?.status === "done" && error === null
  const planId = plan?.planId ?? null
  useEffect(() => {
    onChoice(done && planId !== null ? { planId, skip: [...skip] } : null)
  }, [done, planId, skip, onChoice])

  const files = useMemo(() => plan?.files ?? [], [plan])
  const affected = stPlanAffectedBySkip(files, skip)
  const listed = files.filter(
    (file) =>
      file.status !== "done" ||
      file.target !== "existing" ||
      changes(file.counts) ||
      affected.has(file.path) ||
      skip.has(file.path)
  )
  const quiet = files.length - listed.length
  const choices = files.filter(choosable)
  const total = files.reduce(
    (sum, file) =>
      skip.has(file.path) || file.target === "bin" || file.target === "greeting"
        ? sum
        : {
            newMessages: sum.newMessages + file.counts.newMessages,
            newSwipes: sum.newSwipes + file.counts.newSwipes
          },
    { newMessages: 0, newSwipes: 0 }
  )

  if (error !== null)
    return (
      <Alert
        tone="danger"
        title="The chats already here couldn't be checked"
        actions={
          <Button hint="Works out again what importing does to the chats already here." onClick={checkAgain}>
            Check again
          </Button>
        }
      >
        <p>{error}</p>
      </Alert>
    )
  if (plan === null)
    return <p className="text-sm text-muted">Checking what importing does to the chats already here…</p>
  if (plan.files.length === 0)
    return (
      <p className="text-sm text-muted">
        New-chat counts are estimates. New files aren’t checked; some may be skipped or join another chat.
      </p>
    )

  return (
    <section aria-label="Chats already here" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Chats already here</h3>
        <p className="text-sm text-muted">
          What importing does to the chats you already have. Nothing changes until you import.
        </p>
      </div>
      <p className="text-sm text-muted">
        New-chat counts are estimates. New files aren’t checked; some may be skipped or join another chat.
      </p>
      {plan.status === "running" && (
        <div className="flex flex-col gap-2">
          <ProgressBar
            className="h-2 w-full"
            max={Math.max(1, plan.bytesTotal)}
            value={plan.bytesDone}
            label="Checked so far"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-sm text-muted [overflow-wrap:anywhere]">
              {`Checked ${plan.filesDone} of ${plan.files.length}`}
              {plan.currentFile !== null && `: ${fileName(plan.currentFile)}`}
            </p>
            <Button
              hint="Stops checking. You can import once a check is finished."
              onClick={() => void call(registry, (client) => client("CancelStImportPlan", { planId: plan.planId }))}
            >
              Stop checking
            </Button>
          </div>
        </div>
      )}
      {plan.status === "cancelled" && (
        <Alert
          tone="warning"
          title="Checking stopped"
          actions={
            <Button hint="Works out again what importing does to the chats already here." onClick={checkAgain}>
              Check again
            </Button>
          }
        >
          <p>Import is available once a check is finished.</p>
        </Alert>
      )}
      {plan.status === "failed" && (
        <Alert
          tone="danger"
          title="The check failed"
          actions={
            <Button hint="Works out again what importing does to the chats already here." onClick={checkAgain}>
              Check again
            </Button>
          }
        >
          <p>{plan.error ?? "Try again."}</p>
        </Alert>
      )}
      {plan.status === "done" && (
        <p className="text-sm">
          {affected.size > 0
            ? "Message counts cannot be predicted while an earlier file for the same chat is skipped."
            : total.newMessages + total.newSwipes === 0
              ? "Nothing new for the chats already here."
              : `Importing adds ${plural(total.newMessages, "message", "messages")} and ${plural(total.newSwipes, "swipe", "swipes")} to them.`}
        </p>
      )}
      {choices.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <Button
            hint="Takes in every file's changes."
            disabled={plan.status !== "done" || skip.size === 0}
            onClick={() => setSkip(new Set())}
          >
            Include all
          </Button>
          <Button
            hint="Leaves every chat already here as it is; new chats still come in."
            disabled={plan.status !== "done" || choices.every((file) => skip.has(file.path))}
            onClick={() => setSkip(new Set(choices.map((file) => file.path)))}
          >
            Skip all
          </Button>
        </div>
      )}
      <ul aria-label="Files for chats already here" className="flex flex-col divide-y divide-border">
        {listed.slice(Math.max(0, filesShown - FILES_SHOWN), filesShown).map((file) => (
          <FileRow
            key={file.path}
            plan={plan}
            file={file}
            skipped={skip.has(file.path)}
            uncertain={affected.has(file.path)}
            onSkip={(skipped) => {
              const next = new Set(skip)
              if (skipped) next.add(file.path)
              else next.delete(file.path)
              setSkip(next)
            }}
          />
        ))}
      </ul>
      {filesShown > FILES_SHOWN && (
        <Button
          className="self-start"
          hint="Lists the previous files."
          onClick={() => setFilesShown(Math.max(FILES_SHOWN, filesShown - FILES_SHOWN))}
        >
          Previous files
        </Button>
      )}
      {listed.length > filesShown && (
        <Button
          className="self-start"
          hint="Lists the next files that change a chat already here."
          onClick={() => setFilesShown(filesShown + FILES_SHOWN)}
        >
          Next files
        </Button>
      )}
      {quiet > 0 && plan.status === "done" && (
        <p className="text-sm text-muted">{`${plural(quiet, "more file has", "more files have")} nothing new.`}</p>
      )}
      <p className="text-sm text-muted">
        Counts assume each file can be linked to a card. Card links are checked during import; a file needing your
        choice may wait in the report or be listed under Not imported.
      </p>
      <p className="text-sm text-muted">
        Importing never undoes what you did here: the swipe you chose, your edits, messages you hid or deleted, your
        notes and summaries stay.
      </p>
    </section>
  )
}
