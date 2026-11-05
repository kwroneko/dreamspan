// The run inspector's agent part (spec/AGENTIC.md §5.3; DESIGN §7.4): for a reply written by a
// tool-using loop, after the request's context, the tools it was offered exactly as frozen into
// its snapshot, then every request the loop made after the first, each with what was added to
// the context since the one before (the tools' results, the app's own messages) and the model's
// turn, all verbatim. Request N's context is the request above plus everything listed before it.
// A plain reply's run has no transcript, and this shows nothing.
import type { OfferedTool, TranscriptEntry, TurnPart } from "@rp/shared/agent.ts"
import type { InspectorUsage, RunContext } from "@rp/shared/inspectorApi.ts"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useMemo } from "react"
import { AppClient } from "../../../rpc.ts"
import { Card, CardHeader, Disclosure } from "../../../ui/Surface.tsx"
import { requestStatusText } from "../requestWords.ts"
import { turnsOf } from "./steps.ts"

const json = (value: unknown) => JSON.stringify(value, null, 2)

const count = (n: number | null) => (n === null ? "unknown" : n.toLocaleString())

/** A titled box, as the inspector's context blocks are: the inspector's label above the verbatim text. */
function Box({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-md border border-border">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border bg-surface-raised px-2.5 py-1.5 font-sans text-xs">
        <span className="font-medium text-text">{title}</span>
        {note && <span className="text-muted">{note}</span>}
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

function Tools({ tools }: { tools: ReadonlyArray<OfferedTool> }) {
  return (
    <section aria-label="Tools offered" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Tools offered</h2>
      <p className="text-sm text-muted">Available to this run, as defined when it started.</p>
      {tools.map((tool) => (
        <Box key={tool.name} title={tool.name} note={tool.label}>
          <div className="flex flex-col gap-1">
            <Verbatim text={tool.description} />
            <Disclosure title="Parameters" hint={`Click to show or hide the parameters of ${tool.name}`}>
              <Verbatim text={json(tool.parameters)} />
            </Disclosure>
          </div>
        </Box>
      ))}
    </section>
  )
}

function Part({ part }: { part: TurnPart }) {
  if (part.type === "toolCall")
    return (
      <Box title={`Tool call: ${part.name}`} note={part.id}>
        <Verbatim text={json(part.args)} />
      </Box>
    )
  return (
    <Box title={part.type === "thinking" ? "Thinking" : "Text"}>
      <Verbatim text={part.text} />
    </Box>
  )
}

function Added({ entry }: { entry: Exclude<TranscriptEntry, { role: "assistant" }> }) {
  return entry.role === "toolResult" ? (
    <Box title={`Result of ${entry.tool}${entry.isError ? " (an error)" : ""}`} note={entry.toolCallId}>
      <Verbatim text={entry.text} />
    </Box>
  ) : (
    <Box title="Added by the app">
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

function Steps({ run, entries }: { run: RunContext; entries: ReadonlyArray<TranscriptEntry> }) {
  const turns = turnsOf(entries)
  // Each request's ledger row, when they line up one for one (a retry adds a row of its own).
  const answered = turns.filter((t) => t.answer !== null).length
  const usage = run.requests.length === answered ? run.requests : null
  return (
    <section aria-label="Steps" id="run-steps" className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Steps</h2>
      <p className="text-sm text-muted">
        Every request of this run after the first is the context above, then everything listed before it here.
      </p>
      {turns.map((turn, i) => (
        <Card key={i}>
          <CardHeader title={turn.answer === null ? "Not sent" : `Request ${i + 1}`} />
          <div className="flex flex-col gap-2">
            {i === 0 && turn.added.length === 0 && <p className="text-sm text-muted">The context above, as it was.</p>}
            {turn.added.length > 0 && (
              <>
                <h3 className="text-sm font-medium">
                  {turn.answer === null ? "Added after the last answer" : "Added to the context"}
                </h3>
                {turn.added.map((entry, j) => (
                  <Added key={j} entry={entry} />
                ))}
              </>
            )}
            {turn.answer && (
              <>
                <p className="text-sm text-muted">
                  {turn.answer.toolsOffered ? "The tools above were offered." : "No tools were offered."}
                </p>
                <h3 className="text-sm font-medium">The model's answer</h3>
                {turn.answer.parts.length === 0 && <p className="text-sm text-muted">Nothing came back.</p>}
                {turn.answer.parts.map((part, j) => (
                  <Part key={j} part={part} />
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
      ))}
    </section>
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
    <>
      {transcript.tools.length > 0 && <Tools tools={transcript.tools} />}
      {transcript.entries.length > 0 && <Steps run={run} entries={transcript.entries} />}
    </>
  )
}
