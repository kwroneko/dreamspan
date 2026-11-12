// Workshop turn continuity is a delta from reference-harness's loadCompletedSessionMaterial:
// retain the frozen request and the WHOLE transcript; verify the shown path before reuse.
import type { PathWindow } from "@rp/shared/chatApi.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { PathEntry } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { ASSEMBLER_VERSION, type ContextSnapshot } from "../assembler/types.ts"
import type { Reader } from "../db/Database.ts"
import type { GenerationRequest } from "../chat/Generator.ts"
import { stepsOf } from "./steps.ts"
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
  if (stored.status !== "completed")
    return {
      reason: "The previous run did not finish. This request was put together again; Resume can carry on that run."
    } as const
  if (
    snapshot.inputs.model?.connectionId !== fresh.inputs.model?.connectionId ||
    snapshot.inputs.model?.modelId !== fresh.inputs.model?.modelId
  )
    return { reason: "The model changed, so this request was put together again." } as const
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
    if (words.length) summaries[entry.version.id] = `[Steps: ${words.join("; ").replaceAll(/\s+/g, " ")}]`
  }
  return summaries
})
