// The run inspector's agent part (spec/AGENTIC.md §5.3; DESIGN §7.4): for a reply written by a
// tool-using loop, after the request's context, the tools it was offered exactly as frozen into
// its snapshot, then every request the loop made after the first, each with what was added to
// the context since the one before (the tools' results, the app's own messages) and the model's
// turn, all verbatim. Request N's context is the request above plus everything listed before it.
// A plain reply's run has no transcript, and this shows nothing.
// An MCP server's tools are grouped under their server, its calls say where and when they were
// sent from the call ledger, and their results show what the model was sent of them (spec/MCP.md §10).
//
// Each step (thinking or text before a tool call, a call's arguments, its result) has Edit and
// Resume from here (§4.4): the run carried on from that step, changed first or not, as a new
// version of the message, which the chat then shows being written. What a resume or an edit cut
// from the run it carried on shows folded where it was cut. Step edits use server-kept drafts;
// the URL records which editor is open, so reloading restores both the editor and its text.
import type {
  ContractAttempt,
  ContractFailure,
  ContractRecord,
  CutSpan,
  McpCallLine,
  OfferedTool,
  StepEdit,
  TranscriptEntry,
  TurnPart
} from "@dreamspan/shared/agent.ts"
import type { ForkId, VersionId } from "@dreamspan/shared/chat.ts"
import type { InspectorUsage, RunContext } from "@dreamspan/shared/inspectorApi.ts"
import { displayToolData } from "@dreamspan/shared/toolData.ts"
import { useAtomValue } from "@effect/atom-react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { Effect } from "effect"
import { AsyncResult } from "effect/reactivity"
import { createContext, Fragment, type ReactNode, useContext, useMemo, useState } from "react"
import { ChatPlaceScope, chatPlaceKey } from "../chatPlace.ts"
import { useUserDraft, UserDraftNotices, UserDraftUndo } from "../../editor/userDraft.tsx"
import { useAction } from "../../../actions.tsx"
import { AppClient } from "../../../rpc.ts"
import { Button } from "../../../ui/Button.tsx"
import { CodeEditor } from "../../../ui/CodeEditor.tsx"
import { Card, CardHeader, Disclosure } from "../../../ui/Surface.tsx"
import { requestStatusText } from "../requestWords.ts"
import { editableText, stepEdit, type StepTarget } from "./resume.ts"
import { turnsOf } from "./steps.ts"
import { guardReply } from "../replyGuards.ts"
import { formatWhen } from "../chatTitle.ts"
import { bytesLabel, callStatusLabels } from "../../mcp/data.ts"

const json = (value: unknown) => JSON.stringify(value, null, 2)

const count = (n: number | null) => (n === null ? "unknown" : n.toLocaleString())

/** A titled box, as the inspector's context blocks are: the inspector's label above the verbatim text. */
function Box({
  title,
  note,
  actions,
  children
}: {
  title: string
  note?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-md border border-border">
      <header
        className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-surface-raised px-2.5 font-sans text-xs ${actions ? "py-2" : "py-1.5"}`}
      >
        <span className="font-medium text-text">{title}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {note && <span className="min-w-0 text-muted [overflow-wrap:anywhere]">{note}</span>}
          {actions}
        </span>
      </header>
      <div className="bg-canvas px-2.5 py-2">{children}</div>
    </section>
  )
}

function Verbatim({ text }: { text: string }) {
  return (
    <pre className="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-text">
      {text === "" ? <span className="font-sans text-muted italic">(empty)</span> : text}
    </pre>
  )
}

const tokens = (n: number) => `${n.toLocaleString()} ${n === 1 ? "token" : "tokens"}`

function ToolBox({ tool, note }: { tool: OfferedTool; note: string }) {
  return (
    <Box title={tool.name} note={note}>
      <div className="flex flex-col gap-1">
        <Verbatim text={tool.description} />
        <Disclosure title="Parameters" hint={`Click to show or hide the parameters of ${tool.name}`}>
          <Verbatim text={json(tool.parameters)} />
        </Disclosure>
      </div>
    </Box>
  )
}

/** One group of the offer, with its total size. */
function ToolGroup({
  title,
  about,
  tools,
  note
}: {
  title: string
  about: string
  tools: ReadonlyArray<OfferedTool>
  note: (tool: OfferedTool) => string
}) {
  if (tools.length === 0) return null
  const total = tools.reduce((n, t) => n + (t.tokens ?? 0), 0)
  const counted = tools.every((t) => t.tokens !== undefined)
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        {title}{" "}
        <span className="font-normal text-muted">
          · {tools.length === 1 ? "1 tool" : `${tools.length} tools`}
          {counted ? `, ${tokens(total)}` : ""}
        </span>
      </h3>
      <p className="text-sm text-muted">{about}</p>
      {tools
        .filter((tool) => tool.mcp === undefined)
        .map((tool) => (
          <ToolBox key={tool.name} tool={tool} note={note(tool)} />
        ))}
      {serversOf(tools).map(({ connection, name, listedAt, tools: own }) => (
        <section
          key={connection}
          aria-label={`From ${name}`}
          className="flex flex-col gap-2"
          data-mcp-tools={connection}
        >
          <h4 className="text-sm font-medium">
            From {name}
            {listedAt === null ? "" : <span className="font-normal text-muted">, listed {formatWhen(listedAt)}</span>}
          </h4>
          {own.map((tool) => (
            <ToolBox key={tool.name} tool={tool} note={note(tool)} />
          ))}
        </section>
      ))}
    </section>
  )
}

/** A group's MCP server tools under their server (spec/MCP.md §10), in the order offered. */
const serversOf = (tools: ReadonlyArray<OfferedTool>) => {
  const servers = new Map<
    string,
    { connection: string; name: string; listedAt: number | null; tools: Array<OfferedTool> }
  >()
  for (const tool of tools) {
    if (tool.mcp === undefined) continue
    const server = servers.get(tool.mcp.connection)
    if (server) server.tools.push(tool)
    else
      servers.set(tool.mcp.connection, {
        connection: tool.mcp.connection,
        name: tool.mcp.connectionName,
        listedAt: tool.mcp.listedAt,
        tools: [tool]
      })
  }
  return [...servers.values()]
}

/** What the run's MCP calls need in their steps: their tools' servers and the ledger's rows. */
interface McpFacts {
  readonly tools: ReadonlyMap<string, NonNullable<OfferedTool["mcp"]>>
  readonly calls: ReadonlyMap<string, ReadonlyArray<McpCallLine>>
}
const McpFactsContext = createContext<McpFacts>({ tools: new Map(), calls: new Map() })

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })

/** "1.2 s", "340 ms", or "…" while it runs. */
const tookLabel = (line: McpCallLine) => {
  if (line.endedAt === null) return "…"
  const ms = line.endedAt - line.startedAt
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/**
 * Where an MCP call went (spec/MCP.md §10): one line per attempt the ledger recorded, "Sent to
 * api.example.com (Archive) at 14:02:11 · 1.2 s · 3 KB back", or that it was never sent.
 */
function McpSentLines({
  server,
  lines
}: {
  server: NonNullable<OfferedTool["mcp"]>
  lines: ReadonlyArray<McpCallLine>
}) {
  const where =
    server.host === "a local program"
      ? `Run as a local program (${server.connectionName})`
      : `Sent to ${server.host} (${server.connectionName})`
  if (lines.length === 0)
    return (
      <p className="font-sans text-xs text-muted" data-mcp-sent="none">
        Never sent to {server.connectionName}.
      </p>
    )
  return (
    <ul className="flex flex-col gap-0.5 font-sans text-xs text-muted tabular-nums" data-mcp-sent={lines.length}>
      {lines.map((line) => (
        <li key={`${line.attempt}:${line.startedAt}`} className="[overflow-wrap:anywhere]">
          {lines.length > 1 ? `Attempt ${line.attempt}: ` : ""}
          {where} at {clock.format(line.startedAt)} · {tookLabel(line)} · {bytesLabel(line.receivedBytes)} back
          {line.status === "complete" ? "" : ` · ${callStatusLabels[line.status]}`}
        </li>
      ))}
    </ul>
  )
}

/**
 * The run's tools as frozen when it started (spec/TOOL-LOADING.md): those sent from the start,
 * then those the assistant loaded as it went (and the tool that loaded them), then those it
 * never needed. A run that loads nothing shows one list, as before.
 */
export function Tools({
  tools,
  entries
}: {
  tools: ReadonlyArray<OfferedTool>
  entries: ReadonlyArray<TranscriptEntry>
}) {
  const loaderOf = new Map(entries.flatMap((e) => (e.role === "toolResult" ? [[e.toolCallId, e.tool] as const] : [])))
  const size = (tool: OfferedTool) => (tool.tokens === undefined ? "" : ` · ${tokens(tool.tokens)}`)
  const immediate = tools.filter((t) => !t.deferred)
  const loaded = tools.filter((t) => t.deferred && t.loadedBy !== undefined)
  const unused = tools.filter((t) => t.deferred && t.loadedBy === undefined)
  const deferring = loaded.length + unused.length > 0
  return (
    <section aria-label="Tools offered" className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Tools offered</h2>
      <ToolGroup
        title={deferring ? "Sent from the start" : "Available to this run"}
        about={
          deferring
            ? "In every request of this run, as defined when it started."
            : "Available to this run, as defined when it started."
        }
        tools={immediate}
        note={(tool) => `${tool.label}${size(tool)}`}
      />
      <ToolGroup
        title="Loaded during the run"
        about="Their definitions were sent only after the assistant loaded them."
        tools={loaded}
        note={(tool) => {
          const loader = loaderOf.get(tool.loadedBy!)
          return `${tool.label}${size(tool)} · loaded ${loader === undefined ? "during the run" : `by ${loader}`}`
        }}
      />
      <ToolGroup
        title="Never loaded"
        about="Available to load, but this run didn't need them, so their definitions were never sent."
        tools={unused}
        note={(tool) => `${tool.label}${size(tool)}`}
      />
    </section>
  )
}

const FAILURE_WORDS: Record<ContractFailure, string> = {
  invalid_tool_call: "Its send was refused",
  textual_tool_call: "Wrote a tool call as text",
  context_mimicry: "Copied the chat's own markup",
  text_only: "Wrote text without sending it",
  empty: "Wrote nothing"
}

const ENDING_WORDS = {
  sent: "Sent the reply",
  passed: "Stayed silent",
  written: "Wrote the reply when asked to write it now"
} as const

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`)

/** The run's outcome in a sentence: how its reply was given, and how often the app asked. */
const contractSummary = (record: ContractRecord) => {
  const asked = times(record.nudges)
  switch (record.outcome) {
    case "clean":
      return record.attempts.at(-1)?.ending === "passed" ? "Stayed silent at once." : "Sent at once."
    case "recovered":
      return `Sent after the app asked ${asked}.`
    case "gave_up":
      return `Stayed silent after the app asked ${asked}.`
    case "exhausted":
      return `Never sent, though the app asked ${asked}.`
    case "stopped":
      return record.nudges > 0 ? `Stopped before it was sent; the app asked ${asked}.` : "Stopped before it was sent."
    case "failed":
      return record.nudges > 0 ? `Failed before it was sent; the app asked ${asked}.` : "Failed before it was sent."
    case "capped":
      return record.nudges > 0
        ? `Used every model request without sending; the app asked ${asked}.`
        : "Used every model request without sending."
    default:
      return record.nudges > 0 ? `Not finished; the app asked ${asked}.` : "Not finished."
  }
}

const attemptWords = (attempt: ContractAttempt) =>
  [
    ...(attempt.ending === "failed" ? attempt.failures.map((f) => FAILURE_WORDS[f]) : [ENDING_WORDS[attempt.ending]]),
    ...(attempt.cut ? ["cut when this reply was resumed"] : [])
  ].join(" · ")

/**
 * How the run met the send tool's contract (spec/REPLY-CONTRACT.md §3.6): each time it ended a
 * turn, and why that wasn't the reply. A run that sent at once shows the sentence alone.
 */
function ReplyAttempts({ record }: { record: ContractRecord }) {
  const listed = record.attempts.length > 1 || record.attempts.some((a) => a.ending === "failed")
  return (
    <section aria-label="Reply attempts" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Reply attempts</h2>
      <p className="text-sm text-muted">
        {contractSummary(record)} Only a send_message call gives the reply; the app asks again when a turn ends without
        one.
      </p>
      {listed && (
        <ol className="flex flex-col gap-1 text-sm">
          {record.attempts.map((attempt, i) => (
            <li key={i} data-ending={attempt.ending} className="flex gap-2">
              <span className="w-5 shrink-0 text-right text-muted tabular-nums">{i + 1}.</span>
              <span className={attempt.ending === "failed" ? "text-text" : "text-success"}>
                {attemptWords(attempt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** What step edits need from the page: the tools' schemas, which step is open, and carrying on. */
interface StepEditing {
  readonly tools: ReadonlyArray<OfferedTool>
  readonly draftTarget: string
  /** The run is still going: its steps can't be carried on from yet. */
  readonly running: boolean
  readonly open: string | null
  readonly setOpen: (key: string | null) => void
  readonly resume: (step: number, edit: StepEdit | undefined) => Promise<boolean>
  readonly pending: boolean
  readonly error: string | null
}

/** A side chat's story text arrives quoted (spec/WORKSHOP.md §4): the inspector says so plainly. */
const quotesStory = (target: StepTarget) =>
  target.kind === "result" && !target.entry.isError && target.entry.text.startsWith("<story_excerpt ")

const titleOf = (target: StepTarget, mcp = false) =>
  target.kind === "result"
    ? mcp
      ? `What the server returned${target.entry.isError ? " (an error)" : ""}`
      : `Result of ${target.entry.tool}${target.entry.isError ? " (an error)" : quotesStory(target) ? ": story text, quoted for the assistant to discuss" : ""}`
    : target.part.type === "toolCall"
      ? mcp
        ? `Sent to the server: ${target.part.name}`
        : `Tool call: ${target.part.name}`
      : target.part.type === "thinking"
        ? "Thinking"
        : "Text"

const noteOf = (target: StepTarget) =>
  target.kind === "result" ? target.entry.toolCallId : target.part.type === "toolCall" ? target.part.id : undefined

const toolOf = (target: StepTarget) =>
  target.kind === "result" ? target.entry.tool : target.part.type === "toolCall" ? target.part.name : null

/** A step's box: its text, or its editor once Edit is chosen, with Edit and Resume from here. */
function StepBox({ target, editing, id }: { target: StepTarget; editing: StepEditing | null; id: string }) {
  const step = target.kind === "result" ? target.entry.step : target.part.step
  const original = editableText(target)
  const facts = useContext(McpFactsContext)
  const toolName = toolOf(target)
  const server = toolName === null ? undefined : facts.tools.get(toolName)
  const title = titleOf(target, server !== undefined)
  const note = noteOf(target)
  // A server call's box says where it went; its result, what the model was sent of it.
  const callId = target.kind === "part" && target.part.type === "toolCall" ? target.part.id : null
  const sentLines =
    server !== undefined && callId !== null ? (
      <McpSentLines server={server} lines={facts.calls.get(callId) ?? []} />
    ) : null
  const modelSaw =
    server !== undefined && target.kind === "result" && target.entry.sent !== undefined ? (
      <Disclosure title="What the model saw" hint="Click to show or hide the part of this result the model was sent">
        <Verbatim text={displayToolData(target.entry.sent)} />
      </Disclosure>
    ) : null
  const shown =
    target.kind === "result"
      ? displayToolData(original)
      : target.part.type === "toolCall"
        ? json(target.part.args)
        : original
  if (editing === null || step === undefined || editing.running)
    return (
      <Box title={title} {...(note ? { note } : {})}>
        {sentLines}
        <Verbatim text={shown} />
        {modelSaw}
      </Box>
    )
  const open = editing.open === id
  // A turn that wrote nothing has nothing to change; it can still be carried on from.
  const editable = !(target.kind === "part" && target.part.type === "text" && target.part.text === "")
  const actions = open ? null : (
    <span className="flex gap-1">
      {editable && (
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          hint="Change this step, then carry on from it as a new version."
          disabled={editing.pending}
          onClick={() => editing.setOpen(id)}
        >
          Edit
        </Button>
      )}
      <Button
        variant="ghost"
        className="h-7 px-2 text-xs"
        hint="Carry on from this step as a new version."
        disabled={editing.pending}
        onClick={() => void editing.resume(step, undefined)}
      >
        Resume from here
      </Button>
    </span>
  )
  return (
    <Box title={title} {...(note ? { note } : {})} actions={actions}>
      {sentLines}
      {open ? <StepEditor target={target} editing={editing} id={id} step={step} /> : <Verbatim text={shown} />}
      {!open && modelSaw}
    </Box>
  )
}

/** A draft is scoped to this version and this part/result, shared by tabs and devices. */
function StepEditor({
  target,
  editing,
  id,
  step
}: {
  target: StepTarget
  editing: StepEditing
  id: string
  step: number
}) {
  const original = editableText(target)
  const draft = useUserDraft(editing.draftTarget, id, original)
  const [committing, setCommitting] = useState(false)
  const text = draft.text
  const title = titleOf(target)
  const isArgs = target.kind === "part" && target.part.type === "toolCall"
  const parameters = editing.tools.find((t) => t.name === toolOf(target))?.parameters
  const checked = stepEdit(target, text, parameters)
  const problem = "problem" in checked ? checked.problem : null
  return (
    <div className="flex flex-col gap-2">
      <CodeEditor
        label={`Edit ${title}`}
        value={text}
        base={original}
        mono={isArgs}
        rows={isArgs ? 6 : 4}
        textActions={!isArgs}
        expand={false}
        autoFocus
        onChange={draft.setText}
        tools={<UserDraftUndo draft={draft} />}
      />
      <UserDraftNotices draft={draft} />
      {problem !== null && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
      {editing.error !== null && (
        <p role="alert" className="text-sm text-danger">
          {editing.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          pending={editing.pending || committing}
          disabled={problem !== null || !draft.ready}
          hint={
            text === original
              ? "Carry on from this step, unchanged, as a new version."
              : "Carry on from this step, as you changed it, as a new version."
          }
          onClick={() => {
            if (!("edit" in checked) || committing) return
            setCommitting(true)
            void draft.commit(text, () => editing.resume(step, checked.edit)).finally(() => setCommitting(false))
          }}
        >
          Resume
        </Button>
        <Button
          variant="ghost"
          disabled={editing.pending || committing}
          hint="Close the editor; your draft is kept for later."
          onClick={() => editing.setOpen(null)}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

function Part({ part, editing, id }: { part: TurnPart; editing: StepEditing | null; id: string }) {
  return <StepBox target={{ kind: "part", part }} editing={editing} id={id} />
}

function Added({
  entry,
  editing,
  id
}: {
  entry: Exclude<TranscriptEntry, { role: "assistant" }>
  editing: StepEditing | null
  id: string
}) {
  return entry.role === "toolResult" ? (
    <StepBox target={{ kind: "result", entry }} editing={editing} id={id} />
  ) : (
    <Box title={entry.nudge === undefined ? "Added by the app" : "The app asked for the reply to be sent"}>
      <Verbatim text={entry.text} />
    </Box>
  )
}

function UsageLine({ request }: { request: InspectorUsage }) {
  const c = request.counts
  const input = c.inputUncached === null ? null : c.inputUncached + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0)
  return (
    <p className="text-xs text-muted tabular-nums">
      {requestStatusText(request.status)}: input {count(input)}, cache read {count(c.cacheRead)}, output{" "}
      {count(c.output)}, cost {request.cost ? `${request.cost.amount.toFixed(4)} ${request.cost.currency}` : "unknown"}
      {request.usageSource === "estimated" && " (estimated)"}
    </p>
  )
}

/** How many transcript entries a turn holds: what it added, and its answer. */
const sizeOf = (turn: ReturnType<typeof turnsOf>[number]) => turn.added.length + (turn.answer === null ? 0 : 1)

const CUT_TITLE = { edit: "Cut when this step was edited", resume: "Cut when this reply was resumed" } as const

/** What resuming dropped from the run it carried on, folded where it was cut: verbatim, without actions. */
function Cut({ span }: { span: CutSpan }) {
  return (
    <div data-run-cut={span.reason} className="rounded-md border border-dashed border-border px-2.5 py-1">
      <Disclosure
        title={CUT_TITLE[span.reason]}
        hint="Click to show or hide what the earlier run had from here, which this run doesn’t."
      >
        <div className="flex flex-col gap-2">
          {span.entries.length === 0 && <p className="text-sm text-muted">Nothing was cut.</p>}
          {span.entries.map((entry, i) =>
            entry.role === "assistant" ? (
              <Fragment key={i}>
                {entry.parts.map((part, j) => (
                  <Part key={j} part={part} editing={null} id="" />
                ))}
                {entry.error && <p className="text-sm text-danger">{entry.error}</p>}
              </Fragment>
            ) : (
              <Added key={i} entry={entry} editing={null} id="" />
            )
          )}
        </div>
      </Disclosure>
    </div>
  )
}

export function Steps({
  requests,
  entries,
  cut,
  editing,
  first = "Every request of this run after the first is the context above, then everything listed before it here."
}: {
  requests: ReadonlyArray<InspectorUsage>
  entries: ReadonlyArray<TranscriptEntry>
  cut: ReadonlyArray<CutSpan>
  /** Null: shown without Edit or Resume from here (a subagent's own run). */
  editing: StepEditing | null
  first?: string
}) {
  const turns = turnsOf(entries)
  // Each request's ledger row, when they line up one for one (a retry adds a row of its own).
  const answered = turns.filter((t) => t.answer !== null).length
  const usage = requests.length === answered ? requests : null
  // A cut span shows just before the entry it was cut at, or after the last.
  const cutsAt = (at: number) => cut.filter((span) => Math.min(span.at, entries.length) === at)
  const cuts = (at: number) => cutsAt(at).map((span, i) => <Cut key={`cut-${at}-${i}`} span={span} />)
  // Where each turn's first entry is in `entries`.
  const starts = turns.reduce<Array<number>>(
    (at, turn, i) => [...at, (at[i - 1] ?? 0) + (i === 0 ? 0 : sizeOf(turns[i - 1]!))],
    []
  )
  return (
    <section aria-label="Steps" id="run-steps" className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Steps</h2>
      <p className="text-sm text-muted">{first}</p>
      {turns.map((turn, i) => {
        const first = starts[i]!
        const answerAt = first + turn.added.length
        return (
          <Card key={i}>
            <CardHeader title={turn.answer === null ? "Not sent" : `Request ${i + 1}`} />
            <div className="flex flex-col gap-2">
              {i === 0 && turn.added.length === 0 && (
                <p className="text-sm text-muted">The context above, as it was.</p>
              )}
              {turn.added.length > 0 && (
                <>
                  <h3 className="text-sm font-medium">
                    {turn.answer === null ? "Added after the last answer" : "Added to the context"}
                  </h3>
                  {turn.added.map((entry, j) => (
                    <Fragment key={j}>
                      {cuts(first + j)}
                      <Added entry={entry} editing={editing} id={`${first + j}`} />
                    </Fragment>
                  ))}
                </>
              )}
              {turn.answer && (
                <>
                  {cuts(answerAt)}
                  <p className="text-sm text-muted">
                    {turn.answer.toolsOffered ? "The tools above were offered." : "No tools were offered."}
                  </p>
                  <h3 className="text-sm font-medium">The model's answer</h3>
                  {turn.answer.parts.length === 0 && <p className="text-sm text-muted">Nothing came back.</p>}
                  {turn.answer.parts.map((part, j) => (
                    <Part key={j} part={part} editing={editing} id={`${answerAt}:${j}`} />
                  ))}
                  {turn.answer.error && (
                    <p role="note" className="text-sm text-danger">
                      {turn.answer.error}
                    </p>
                  )}
                  {usage?.[i] && <UsageLine request={usage[i]} />}
                </>
              )}
            </div>
          </Card>
        )
      })}
      {cuts(entries.length)}
    </section>
  )
}

/** Step edits' state, and carrying on: the slot's row version where the page shows it, then the new version. */
function useStepEditing(run: RunContext, tools: ReadonlyArray<OfferedTool>): StepEditing {
  const action = useAction()
  const navigate = useNavigate()
  // A chat beside another (the workshop in a story's panel) keeps its choices under its own keys.
  const scope = useContext(ChatPlaceScope)
  const stepEditKey = chatPlaceKey(scope, "stepEdit")
  const forkKey = chatPlaceKey(scope, "fork")
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const open = typeof search[stepEditKey] === "string" ? (search[stepEditKey] as string) : null
  const setOpen = (key: string | null) => {
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, [stepEditKey]: key ?? undefined }),
      resetScroll: false
    })
  }
  const shownFork = search[forkKey]
  const fork = typeof shownFork === "string" && shownFork !== "" ? (shownFork as ForkId) : null
  const [missing, setMissing] = useState<string | null>(null)
  const resume = async (step: number, edit: StepEdit | undefined) => {
    setMissing(null)
    // A guard may hold it back (a reply that changed things outside the chat warns first).
    const go = await guardReply({
      chatId: run.chatId,
      kind: undefined,
      versionId: run.versionId as VersionId,
      hasSteps: true,
      action: "resume-step",
      fromStep: { index: step, keepsCall: edit?.kind === "result" }
    })
    if (!go) return false
    const result = await action.run((client) =>
      Effect.gen(function* () {
        const window = yield* client("ReadPath", {
          chatId: run.chatId,
          forkId: fork,
          leafSlotId: null,
          range: { _tag: "Around", slot: run.slotId },
          limit: 3
        })
        const entry = window.entries.find((e) => e.slotId === run.slotId)
        if (entry === undefined) return null
        return yield* client("ResumeFromStep", {
          versionId: run.versionId,
          step,
          ...(edit === undefined ? {} : { edit }),
          forkId: fork,
          expectedRowVersion: entry.rowVersion
        })
      })
    )
    if (!result.ok) return false
    if (result.value === null) {
      setMissing("This message isn't on this branch any more.")
      return false
    }
    // The chat shows the new version being written, as any reply; one beside another already shows it.
    if (scope === "")
      void navigate({
        to: "/chats/$chatId",
        params: { chatId: run.chatId },
        search: { ...(fork === null ? {} : { fork }), slot: run.slotId }
      })
    return true
  }
  return {
    tools,
    draftTarget: `run-step:${run.versionId}`,
    running: run.status === "running",
    open,
    setOpen: (key) => {
      action.clearError()
      setMissing(null)
      setOpen(key)
    },
    resume,
    pending: action.pending,
    error: missing ?? action.error?.message ?? null
  }
}

function Transcript({
  run,
  tools,
  entries,
  cut,
  mcpCalls
}: {
  run: RunContext
  tools: ReadonlyArray<OfferedTool>
  entries: ReadonlyArray<TranscriptEntry>
  cut: ReadonlyArray<CutSpan>
  mcpCalls: ReadonlyArray<McpCallLine>
}) {
  const editing = useStepEditing(run, tools)
  const facts = useMemo<McpFacts>(() => {
    const calls = new Map<string, Array<McpCallLine>>()
    for (const line of mcpCalls) calls.set(line.toolCallId, [...(calls.get(line.toolCallId) ?? []), line])
    return {
      tools: new Map(tools.flatMap((t) => (t.mcp ? [[t.name, t.mcp] as const] : []))),
      calls
    }
  }, [tools, mcpCalls])
  // Resume from here (not inside an open editor) reports its refusal under the steps' heading.
  const outside = editing.open === null && editing.error !== null
  return (
    <McpFactsContext.Provider value={facts}>
      {tools.length > 0 && <Tools tools={tools} entries={entries} />}
      {outside && (
        <p role="alert" className="text-sm text-danger">
          {editing.error}
        </p>
      )}
      {(entries.length > 0 || cut.length > 0) && (
        <Steps requests={run.requests} entries={entries} cut={cut} editing={editing} />
      )}
    </McpFactsContext.Provider>
  )
}

export function RunSteps({ run }: { run: RunContext }) {
  const atom = useMemo(() => AppClient.query("GetRunTranscript", { versionId: run.versionId }), [run.versionId])
  const result = useAtomValue(atom)
  // Nothing while it loads (the context above says it's loading); a run without steps adds nothing.
  if (AsyncResult.isFailure(result))
    return (
      <p role="alert" className="text-sm text-danger">
        This run's steps couldn't be read.
      </p>
    )
  if (!AsyncResult.isSuccess(result)) return null
  const transcript = result.value
  if (transcript.tools.length === 0 && transcript.entries.length === 0) return null
  return (
    <Transcript
      run={run}
      tools={transcript.tools}
      entries={transcript.entries}
      cut={transcript.cut}
      mcpCalls={transcript.mcpCalls ?? []}
    />
  )
}

/**
 * The run's attempts at a reply, above the sent messages with the request's other facts; the
 * same read as the steps below them (one query per version).
 */
export function RunAttempts({ run }: { run: RunContext }) {
  const atom = useMemo(() => AppClient.query("GetRunTranscript", { versionId: run.versionId }), [run.versionId])
  const result = useAtomValue(atom)
  if (!AsyncResult.isSuccess(result)) return null
  const { tools, entries, contract } = result.value
  if ((tools.length === 0 && entries.length === 0) || !contract || contract.attempts.length === 0) return null
  return <ReplyAttempts record={contract} />
}
