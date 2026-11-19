// The reply contract's mechanical records (spec/REPLY-CONTRACT.md §3.6, milestone 2): a run under
// the send tool, read from its stored transcript and the spans Resume cut from it, as attempts
// (each ending: the turn before a nudge, or the run's last) with what went wrong in each, and the
// run's outcome. A delta from reference-harness's `deriveContractEvents` (src/agent/contract.ts): one run a
// rollout and no contract redos, so no run splitting and no redo numbering; an attempt Resume cut
// counts, as its failure message does (§3.4); no `sent_not_final` (a send ends our run) and no
// `self_talk` (reference-harness's offline audit). Pure: the inspector and the per-model metrics read it.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  CONTRACT_FAILURES,
  type ContractAttempt,
  type ContractFailure,
  type ContractOutcome,
  type ContractRecord
} from "@dreamspan/shared/agent.ts"
import { looksLikeContextMarkup } from "../assembler/contextMarkup.ts"
import { isNudge } from "./messages.ts"
import { NO_REPLY, SEND_MESSAGE } from "./steps.ts"

/** Tool-call markup of the common chat templates and tool-call formats, written as text (reference-harness's). */
const TOOL_CALL_MARKUP: ReadonlyArray<RegExp> = [
  /<\/?(?:[a-z]+:)?(?:tool_calls?|function_calls?|invoke|tool_use)\b/i,
  /<function=/i,
  /<\|(?:tool_call|tool_calls|python_tag)[^>]*\|?>/i,
  /<｜tool[▁_]call/i,
  /\[TOOL_CALLS\]/,
  /\bto=functions\./,
  /"(?:tool_calls|function_call|tool_use)"\s*:/
]

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const namedCalls = (names: ReadonlyArray<string>): Array<RegExp> => {
  if (names.length === 0) return []
  const alt = names.map(escape).join("|")
  return [
    // send_message({...}) / send_message(message="…")
    new RegExp(`\\b(?:functions\\.)?(?:${alt})\\s*\\(\\s*(?:\\{|"|'|\\w+\\s*[=:])`),
    // {"name": "send_message", …}
    new RegExp(`"(?:name|tool|tool_name|function|recipient_name)"\\s*:\\s*"(?:functions\\.)?(?:${alt})"`),
    // send_message {"message": …}
    new RegExp(`\\b(?:${alt})\\b\\s*:?\\s*\\{\\s*"`)
  ]
}

/** Text that tries to call a tool but was written as text (`textual_tool_call`). */
export const looksLikeTextualToolCall = (text: string, toolNames: ReadonlyArray<string>) =>
  TOOL_CALL_MARKUP.some((re) => re.test(text)) ||
  namedCalls([...new Set([SEND_MESSAGE, NO_REPLY, ...toolNames])]).some((re) => re.test(text))

/** A span the run dropped: a Resume (`resume`) or a step edit (`edit`), from `rollout_branches`. */
export interface ContractCut {
  readonly reason: string
  /** Where the kept transcript ended when it was cut: a message index. */
  readonly forkIndex: number
  readonly messages: ReadonlyArray<AgentMessage>
}

interface ContractOptions {
  /** The names the context used (speakers, cards), for `context_mimicry`. */
  readonly names?: ReadonlyArray<string>
  /** The run's tools, for `textual_tool_call`. */
  readonly toolNames?: ReadonlyArray<string>
}

type Item =
  | { readonly kind: "message"; readonly m: AgentMessage; readonly cut: number }
  | { readonly kind: "cut"; readonly reason: string; readonly cut: number }

/**
 * The order the messages were written in: cut k truncated the transcript at its fork index and
 * kept the tail as its messages, so walking the cuts newest first recovers each earlier
 * transcript (reference-harness's `chronology`). `cut`: 0 for the live transcript, else the cut's number.
 */
const chronology = (messages: ReadonlyArray<AgentMessage>, cuts: ReadonlyArray<ContractCut>): Array<Item> => {
  let current: Array<{ m: AgentMessage; cut: number }> = messages.map((m) => ({ m, cut: 0 }))
  const steps: Array<{ reason: string; cut: number; after: typeof current }> = []
  for (let i = cuts.length - 1; i >= 0; i--) {
    const c = cuts[i]!
    const at = Math.max(0, Math.min(c.forkIndex, current.length))
    steps.unshift({ reason: c.reason, cut: i + 1, after: current.slice(at) })
    current = current.slice(0, at).concat(c.messages.map((m) => ({ m, cut: i + 1 })))
  }
  const out: Array<Item> = current.map((x) => ({ kind: "message", ...x }))
  for (const step of steps) {
    out.push({ kind: "cut", reason: step.reason, cut: step.cut })
    for (const x of step.after) out.push({ kind: "message", ...x })
  }
  return out
}

type Assistant = Extract<AgentMessage, { role: "assistant" }>

const textOf = (m: Assistant) =>
  m.content
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("")
    .trim()

/**
 * The attempt `span` holds (the messages since the last ending): its last turn is the ending.
 * Undefined: no ending yet, or a turn that only called other tools (the run went on, or was cut
 * off there). `incomplete`: the ending stopped or failed, which isn't the contract's verdict.
 */
const close = (
  span: ReadonlyArray<{ m: AgentMessage; cut: number }>,
  options: ContractOptions
): Omit<ContractAttempt, "cut"> | "incomplete" | undefined => {
  const at = span.findLastIndex((x) => x.m.role === "assistant")
  if (at < 0) return undefined
  const ending = span[at]!.m as Assistant
  if (ending.stopReason === "aborted" || ending.stopReason === "error") return "incomplete"
  const results = new Map(
    span.flatMap((x) => (x.m.role === "toolResult" ? [[x.m.toolCallId, x.m.isError] as const] : []))
  )
  const calls = ending.content.flatMap((p) => (p.type === "toolCall" ? [p] : []))
  const delivered = (name: string) => calls.some((c) => c.name === name && results.get(c.id) === false)
  if (delivered(SEND_MESSAGE)) return { ending: "sent", failures: [] }
  if (delivered(NO_REPLY)) return { ending: "passed", failures: [] }
  // The answer to the cap's "write now" is the reply (§3.5): the app asked for text.
  const before = span[at - 1]?.m
  if (calls.length === 0 && before?.role === "rpApp" && !isNudge(before)) return { ending: "written", failures: [] }
  // The run went on after other tools (or a call has no result yet): no ending here.
  const contractCalls = calls.filter((c) => c.name === SEND_MESSAGE || c.name === NO_REPLY)
  if (calls.length > 0 && (contractCalls.length === 0 || contractCalls.some((c) => !results.has(c.id))))
    return undefined
  const failures = new Set<ContractFailure>()
  // The last contract call of the attempt was refused (send presence, an empty send).
  const lastContract = span
    .flatMap((x) =>
      x.m.role === "assistant"
        ? x.m.content.flatMap((p) =>
            p.type === "toolCall" && (p.name === SEND_MESSAGE || p.name === NO_REPLY) ? [p.id] : []
          )
        : []
    )
    .at(-1)
  if (lastContract !== undefined && results.get(lastContract) === true) failures.add("invalid_tool_call")
  const text = textOf(ending)
  if (text !== "") {
    if (looksLikeTextualToolCall(text, options.toolNames ?? [])) failures.add("textual_tool_call")
    if (looksLikeContextMarkup(text, options.names ?? [])) failures.add("context_mimicry")
    failures.add("text_only")
  }
  if (failures.size === 0) failures.add("empty")
  return { ending: "failed", failures: CONTRACT_FAILURES.filter((f) => failures.has(f)) }
}

/**
 * A run's contract record from its transcript and the spans cut from it, oldest cut first. A
 * Resume's cut closes the attempt it cut when that one had ended (the exhausted answer Resume
 * writes again); a step edit's cut drops what it cut, the user's change and not the model's.
 */
export const contractAttempts = (
  messages: ReadonlyArray<AgentMessage>,
  cuts: ReadonlyArray<ContractCut>,
  options: ContractOptions = {}
): ContractRecord => {
  // Each attempt with the cut its ending is in (0: the live transcript).
  const attempts: Array<ContractAttempt & { readonly from: number }> = []
  let span: Array<{ m: AgentMessage; cut: number }> = []
  let nudges = 0
  let incomplete = false
  const settle = (cut?: number) => {
    const closed = close(span, options)
    if (closed === "incomplete") incomplete = true
    else if (closed !== undefined) {
      incomplete = false
      const ending = span.findLast((x) => x.m.role === "assistant")!
      attempts.push({ ...closed, cut: ending.cut !== 0, from: ending.cut })
    }
    if (closed !== undefined && closed !== "incomplete") span = []
    else if (cut !== undefined) span = span.filter((x) => x.cut !== cut)
    return closed
  }
  let started = false
  for (const item of chronology(messages, cuts)) {
    if (item.kind === "cut") {
      if (item.reason === "resume") settle(item.cut)
      else {
        // The user replaced what the edit cut: none of it is the model's attempt.
        span = span.filter((x) => x.cut !== item.cut)
        for (let i = attempts.length - 1; i >= 0; i--) if (attempts[i]!.from === item.cut) attempts.splice(i, 1)
      }
      continue
    }
    const { m } = item
    // Everything before the frozen request is the context, not the run.
    if (m.role === "rpRequest") {
      started = true
      continue
    }
    if (!started) continue
    if (isNudge(m)) {
      settle()
      nudges++
      continue
    }
    if (m.role === "assistant" || m.role === "toolResult" || m.role === "rpApp") span.push(item)
  }
  const last = settle()
  if (last === undefined && span.some((x) => x.m.role === "assistant")) incomplete = true
  const final = attempts.at(-1)
  // A run that hasn't reached an ending of its own (it runs, or a nudge waits for its answer).
  const waiting = span.length === 0 && messages.length > 0 && isNudge(messages.at(-1))
  let outcome: ContractOutcome | null = null
  if (final && !incomplete && !waiting)
    outcome =
      final.ending === "failed"
        ? "exhausted"
        : nudges === 0
          ? "clean"
          : final.ending === "passed"
            ? "gave_up"
            : "recovered"
  return { attempts: attempts.map(({ from: _, ...a }) => a), nudges, outcome }
}

/** Whether the run is under the send tool alone: its frozen request says so (`rpRequest.contract`). */
export const underSendContract = (messages: ReadonlyArray<AgentMessage>) =>
  (messages.find((m) => m.role === "rpRequest") as { contract?: string } | undefined)?.contract === SEND_MESSAGE

/** How a run under the send tool ended, as the session saw it (the transcript alone can't say). */
export interface RunEnd {
  /** The nudges ran out (the session's own verdict, §3.4). */
  readonly exhausted: boolean
  /** Stopped before the run reached its own end: the user's Stop, or the app shutting down. */
  readonly stopped: boolean
  /** A provider or app error ended it. */
  readonly failed: boolean
  /** It made as many requests as the request cap allows. */
  readonly capped: boolean
}

/**
 * The outcome a run's record stores once it has ended (the per-model metrics): the transcript's
 * own when its last attempt gave the reply (sent, passed or written), else why the run ended
 * without one. A stop is never `exhausted`, even when the last turn was plain text the stop kept
 * from being nudged; a run the cap ended is `capped`. An ended run with no other cause: `failed`.
 */
export const runOutcome = (record: ContractRecord, end: RunEnd): ContractOutcome => {
  const { outcome } = record
  if (outcome === "clean" || outcome === "recovered" || outcome === "gave_up") return outcome
  if (end.exhausted) return "exhausted"
  if (end.stopped) return "stopped"
  if (end.failed) return "failed"
  if (end.capped) return "capped"
  return "failed"
}
