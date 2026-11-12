// Workshop turn continuity is a delta from reference-harness's loadCompletedSessionMaterial:
// retain the frozen request and the WHOLE transcript; verify the shown path before reuse.
import { isDeepStrictEqual } from "node:util"
import type { PathWindow } from "@rp/shared/chatApi.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { PathEntry } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { ASSEMBLER_VERSION, type ContextSnapshot } from "../assembler/types.ts"
import type { Reader } from "../db/Database.ts"
import type { GenerationRequest } from "../chat/Generator.ts"
import { placedSteps, SEND_MESSAGE, stepsOf } from "./steps.ts"
import type { FrozenTool } from "./tools.ts"

/** WORKSHOP §10 question 4: the authorized initial policy; change this one constant to
 * retain only timeline text instead. Summaries for workshops remain a separate proposal. */
export const WORKSHOP_OVERFLOW_STEP_SUMMARIES = true

export interface ContinuityRecord {
  readonly path: ReadonlyArray<string>
  readonly prefix?: ContextSnapshot
  readonly inspection?: import("../assembler/types.ts").InspectionInputs
  readonly parent?: { readonly rolloutId: string; readonly versionId: string }
  readonly reason?: string
  readonly historical?: number
  readonly breakpoints?: ReadonlyArray<number>
  /** Older tool results the carried transcript left out to make room (WORKSHOP-CONTEXT §2.2). */
  readonly elided?: number
}
export type ContinuousSnapshot = ContextSnapshot & { readonly continuity?: ContinuityRecord }

export const pathStamp = (entry: PathEntry) =>
  JSON.stringify([
    entry.slotId,
    entry.version.id,
    entry.version.rowVersion,
    entry.contextExcluded,
    entry.version.content,
    entry.excludedImages ?? [],
    entry.version.images ?? []
  ])

export const readContinuityPath = Effect.fnUntraced(function* (
  reader: Reader["Service"],
  request: GenerationRequest,
  leaf: PathEntry["slotId"] | null
) {
  const entries: Array<PathEntry> = []
  let from: PathEntry["slotId"] | null = null
  do {
    const window: PathWindow = yield* reader.ReadPath({
      userId: request.userId,
      chatId: request.chatId,
      forkId: request.forkId ?? null,
      leafSlotId: leaf,
      range: from ? { _tag: "Older", from } : { _tag: "Bottom" },
      limit: 500
    })
    entries.unshift(...window.entries)
    from = window.older
  } while (from !== null)
  return entries
})

export const previousRun = Effect.fnUntraced(function* (
  reader: Reader["Service"],
  request: GenerationRequest,
  path: ReadonlyArray<PathEntry>,
  fresh: ContextSnapshot
) {
  const index = path.findLastIndex((entry) => entry.side === "assistant" && entry.version.context !== null)
  if (index < 0) return { reason: "There is no previous run to carry on." } as const
  const previous = path[index]!
  const material = yield* reader
    .RolloutMaterial({ userId: request.userId, versionId: previous.version.id })
    .pipe(Effect.option)
  if (material._tag === "None") return { reason: "The previous run is no longer available." } as const
  const stored = material.value
  const snapshot = JSON.parse(stored.snapshot) as ContinuousSnapshot
  if (snapshot.assemblerVersion !== ASSEMBLER_VERSION)
    return {
      reason: "The previous request used an earlier assembler, so this request was put together again."
    } as const
  if (!stored.transcript || !snapshot.continuity)
    return { reason: "The previous run has no saved transcript, so this request was put together again." } as const
  if (stored.resumed)
    return { reason: "The previous run was resumed or edited, so this request was put together again." } as const
  if (stored.status !== "completed")
    return {
      reason: "The previous run did not finish. This request was put together again; Resume can carry on that run."
    } as const
  if (
    snapshot.inputs.model?.connectionId !== fresh.inputs.model?.connectionId ||
    snapshot.inputs.model?.modelId !== fresh.inputs.model?.modelId
  )
    return { reason: "The model changed, so this request was put together again." } as const
  if (!isDeepStrictEqual(snapshot.inputs.model, fresh.inputs.model))
    return { reason: "The model or connection settings changed, so this request was put together again." } as const
  if (!isDeepStrictEqual(snapshot.inputs.preset, fresh.inputs.preset))
    return { reason: "The preset changed, so this request was put together again." } as const
  // A capability turned on or off changes what the instructions say the assistant may do.
  if (snapshot.agentAssembly?.instructions !== fresh.agentAssembly?.instructions)
    return {
      reason: "What the assistant may do here changed, so this request was put together again."
    } as const
  if (stored.effectsReason) return { reason: stored.effectsReason } as const
  const transcript = JSON.parse(stored.transcript) as Array<AgentMessage>
  const posts = transcript.flatMap((m) =>
    m.role === "toolResult" && m.toolName === "send_message" && !m.isError
      ? [(m.details as { versionId?: string } | null)?.versionId].filter((id): id is string => !!id)
      : []
  )
  // The saved path was verified at this run's start. Only this run's newly posted messages
  // extend it: carried transcripts also hold posts from earlier turns.
  const baseline = snapshot.continuity.path
  const extra = path.slice(baseline.length, index + 1)
  const historicalIds = new Set<string>(path.slice(0, baseline.length).map((e) => e.version.id))
  const produced = posts.filter((id) => !historicalIds.has(id))
  if (!produced.includes(previous.version.id)) produced.push(previous.version.id)
  const unchanged = baseline.every((stamp, at) => path[at] && pathStamp(path[at]!) === stamp)
  if (
    !unchanged ||
    extra.length !== produced.length ||
    extra.some((e, at) => e.version.id !== produced[at] || e.contextExcluded || e.inserted) ||
    path.slice(index + 1).some((e) => e.side !== "user" || !e.inContext || e.inserted)
  )
    return {
      reason:
        "The chat was edited, inserted into, hidden or replaced after the previous run, so this request was put together again."
    } as const
  return {
    snapshot,
    transcript,
    material: stored,
    after: path.slice(index + 1),
    versionId: previous.version.id
  } as const
})

export const summarizeMessageSteps = Effect.fnUntraced(function* (
  reader: Reader["Service"],
  request: GenerationRequest,
  path: ReadonlyArray<PathEntry>
) {
  const summaries: Record<string, string> = {}
  for (const entry of path) {
    if (!entry.inContext || !entry.version.context || entry.side !== "assistant") continue
    const material = yield* reader
      .RolloutMaterial({ userId: request.userId, versionId: entry.version.id })
      .pipe(Effect.option)
    if (material._tag === "None" || !material.value.transcript) continue
    const frozen = JSON.parse(material.value.snapshot) as { agent?: { tools: ReadonlyArray<FrozenTool> } }
    const steps = stepsOf(
      JSON.parse(material.value.transcript) as Array<AgentMessage>,
      frozen.agent?.tools ?? [],
      true,
      entry.version.id
    )
    const words = steps
      .filter((s) => s.kind === "tool")
      .map((s) => `${s.label}${s.title ? `: ${s.title}` : ""}${s.status === "error" ? " (failed)" : ""}`)
    // The number lets read_run read them back (spec/WORKSHOP-CONTEXT.md §3.2).
    if (words.length)
      summaries[entry.version.id] =
        `[Message ${(entry.position ?? entry.depth) + 1} steps: ${words.join("; ").replaceAll(/\s+/g, " ")}]`
  }
  return summaries
})

/**
 * When a carried request passes ELIDE_TRIGGER of the room (the context maximum less the reply
 * reserve), older tool results are left out until it is at most ELIDE_TARGET of it
 * (spec/WORKSHOP-CONTEXT.md §2.2, §7 question 3: LCM's trigger and keep).
 */
export const ELIDE_TRIGGER = 3 / 4
const ELIDE_TARGET = 1 / 2

const ELIDED = "[Result left out to save room."
const elisionMarker = (message: number | null, call: string) =>
  message === null
    ? `${ELIDED} search_chat and read_run can find it again.]`
    : `${ELIDED} read_run with message ${message} and call "${call}" shows it again.]`

const textOf = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((p) => (p.type === "text" && p.text !== undefined ? [p.text] : [])).join("")

/**
 * The message number each tool result of a carried transcript belongs to: the path's newest
 * assistant messages' own steps, read from their runs, aligned with the transcript from its end.
 */
const numberResults = Effect.fnUntraced(function* (
  reader: Reader["Service"],
  request: GenerationRequest,
  path: ReadonlyArray<PathEntry>,
  results: ReadonlyArray<{ readonly index: number; readonly call: string }>
) {
  const steps: Array<{ readonly n: number; readonly call: string }> = []
  const parsed = new Map<
    string,
    { readonly tools: ReadonlyArray<FrozenTool>; readonly transcript: Array<AgentMessage> }
  >()
  let walked = 0
  for (let at = path.length - 1; at >= 0 && steps.length < results.length && walked < 400; at--) {
    const entry = path[at]!
    if (entry.side !== "assistant" || entry.version.context === null) continue
    walked++
    const found = yield* reader
      .RolloutMaterial({ userId: request.userId, versionId: entry.version.id })
      .pipe(Effect.option)
    if (found._tag === "None" || !found.value.transcript) break
    const material = found.value
    const run =
      parsed.get(material.rolloutId) ??
      (() => {
        const frozen = JSON.parse(material.snapshot) as { agent?: { tools: ReadonlyArray<FrozenTool> } }
        const value = {
          tools: frozen.agent?.tools ?? [],
          transcript: JSON.parse(material.transcript!) as Array<AgentMessage>
        }
        parsed.set(material.rolloutId, value)
        return value
      })()
    const n = (entry.position ?? entry.depth) + 1
    steps.unshift(
      ...placedSteps(run.transcript, run.tools, true, entry.version.id).flatMap(({ step }) =>
        step.kind === "tool" ? [{ n, call: step.id }] : []
      )
    )
  }
  const numbers = new Map<number, number>()
  for (let i = results.length - 1, j = steps.length - 1; i >= 0 && j >= 0; i--, j--) {
    if (results[i]!.call !== steps[j]!.call) break
    numbers.set(results[i]!.index, steps[j]!.n)
  }
  return numbers
})

/**
 * Leaves out a carried transcript's older tool results, oldest first, never the last turn's or
 * a post's, until the local estimate reaches the target; `recount` measures the result with the
 * model's tokenizer. Null: nothing could be left out.
 */
export const elideCarried = <E>(input: {
  readonly reader: Reader["Service"]
  readonly request: GenerationRequest
  readonly path: ReadonlyArray<PathEntry>
  readonly transcript: ReadonlyArray<AgentMessage>
  readonly count: number
  readonly room: number
  readonly recount: (transcript: ReadonlyArray<AgentMessage>) => Effect.Effect<number, E>
}) =>
  Effect.gen(function* () {
    const { transcript, count, room } = input
    const lastTurn = transcript.findLastIndex((m) => m.role === "rpUser" || m.role === "rpRequest" || m.role === "user")
    const results = transcript.flatMap((m, index) =>
      m.role === "toolResult" && m.toolName !== SEND_MESSAGE ? [{ index, call: m.toolCallId }] : []
    )
    const candidates = results.filter((r) => {
      const message = transcript[r.index] as AgentMessage & { role: "toolResult" }
      return r.index < lastTurn && !textOf(message.content).startsWith(ELIDED)
    })
    if (candidates.length === 0) return null
    const numbers = yield* numberResults(input.reader, input.request, input.path, results)
    const next = transcript.slice()
    let saved = 0
    let elided = 0
    for (const { index, call } of candidates) {
      if (count - saved <= room * ELIDE_TARGET) break
      const message = next[index] as AgentMessage & { role: "toolResult" }
      const marker = elisionMarker(numbers.get(index) ?? null, call)
      saved += Math.max(0, Math.ceil((textOf(message.content).length - marker.length) / 4))
      next[index] = { ...message, content: [{ type: "text", text: marker }] }
      elided++
    }
    return { transcript: next, count: yield* input.recount(next), elided }
  })
