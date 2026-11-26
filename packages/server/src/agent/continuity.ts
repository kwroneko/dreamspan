// To continue a workshop turn, retain the frozen request and the whole transcript.
// Verify the shown path before reuse.
import { isDeepStrictEqual } from "node:util"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { PathWindow } from "@dreamspan/shared/chatApi.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ChatId, ForkId, PathEntry, StoryAt, VersionId } from "@dreamspan/shared/chat.ts"
import type { RolloutStep } from "@dreamspan/shared/agent.ts"
import { Effect } from "effect"
import { ASSEMBLER_VERSION, type ContextSnapshot } from "../assembler/types.ts"
import type { Reader } from "../db/Database.ts"
import type { GenerationRequest } from "../chat/Generator.ts"
import { placedSteps, SEND_MESSAGE, stepsOf } from "./steps.ts"
import type { Skill } from "./toolLoading.ts"
import type { FrozenTool } from "./tools.ts"

/** Legacy step labels for a fresh build when Summaries is explicitly off. */
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
export type ContinuousSnapshot = ContextSnapshot & {
  readonly continuity?: ContinuityRecord
  readonly storyAt?: StoryAt
  readonly storyStamp?: string | null
  readonly agent?: {
    readonly tools: ReadonlyArray<FrozenTool>
    readonly cardSkills?: ReadonlyArray<Skill>
    readonly turnCap?: number
  }
}

/** A gone or unowned story has no reusable read material. */
export const storyReadStamp = (reader: Reader["Service"], userId: UserId, at: StoryAt | undefined) =>
  at === undefined
    ? Effect.succeed(undefined)
    : reader.StoryReadStamp({ userId, chatId: at.chatId }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))

/**
 * Where a workshop beside a story reads it for a reply in its fork `forkId` (null: its current
 * one): the paired story branch to that branch's newest message now, or where version
 * `versionId` recorded the story standing (spec/WORKSHOP-BRANCHES.md §2.2). Undefined for every
 * other chat, or with the paired branch gone. The server's, never a browser tab's.
 */
export const serverStoryAt = (
  reader: Reader["Service"],
  userId: UserId,
  chatId: ChatId,
  forkId: ForkId | null,
  versionId?: VersionId
) =>
  reader.WorkshopStoryPosition({ userId, chatId, forkId, ...(versionId ? { versionId } : {}) }).pipe(
    Effect.map((at) => at ?? undefined),
    Effect.orElseSucceed(() => undefined)
  )

export const pathStamp = (entry: PathEntry) =>
  JSON.stringify([
    entry.slotId,
    entry.version.id,
    entry.version.rowVersion,
    entry.contextExcluded,
    entry.version.content,
    entry.excludedImages ?? [],
    entry.version.images ?? [],
    // Only when some is hidden, so stamps stored before hiding existed still match.
    ...(entry.hiddenThinking?.length ? [entry.hiddenThinking] : [])
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
  fresh: ContinuousSnapshot
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
  if (!isDeepStrictEqual(snapshot.storyAt, request.storyAt))
    return {
      reason: "The story position changed, so this request was put together again without earlier story reads."
    } as const
  if (snapshot.storyStamp !== fresh.storyStamp)
    return { reason: "The story changed, so this request was put together again without earlier story reads." } as const
  if (snapshot.assemblerVersion !== ASSEMBLER_VERSION)
    return {
      reason:
        "The app changed how requests are built, so this request was put together again. A changed tool list may make it read the chat again once at full input cost."
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
    return {
      reason:
        "The model changed, so this request was put together again. A different tool list makes it read the chat again once at full input cost."
    } as const
  if (!isDeepStrictEqual(snapshot.inputs.model, fresh.inputs.model))
    return {
      reason:
        "The model or connection settings changed, so this request was put together again. A different tool list makes it read the chat again once at full input cost."
    } as const
  if ((snapshot.lcm === undefined) !== (fresh.lcm === undefined))
    return { reason: "The Summaries setting changed, so this request was put together again." } as const
  // A carried prefix is a cache optimization, never authority over the live LCM layer.
  // Compare only coverage/revisions and budgets: recent measures naturally change each turn.
  if (
    fresh.lcm &&
    (!isDeepStrictEqual(snapshot.lcm?.selected, fresh.lcm.selected) ||
      snapshot.lcm?.cursor !== fresh.lcm.cursor ||
      !isDeepStrictEqual(snapshot.lcm?.recentBudget, fresh.lcm.recentBudget) ||
      !isDeepStrictEqual(snapshot.lcm?.layerBudget, fresh.lcm.layerBudget))
  )
    return { reason: "The summaries or their limits changed, so this request was put together again." } as const
  if (!isDeepStrictEqual(snapshot.inputs.preset, fresh.inputs.preset))
    return { reason: "The preset changed, so this request was put together again." } as const
  // A capability turned on or off changes what the instructions say the assistant may do.
  if (snapshot.agentAssembly?.instructions !== fresh.agentAssembly?.instructions)
    return {
      reason: "What the assistant may do here changed, so this request was put together again."
    } as const
  if (!isDeepStrictEqual(snapshot.inputs.cards, fresh.inputs.cards))
    return { reason: "The cards changed, so this request was put together again." } as const
  // Loading results belong to this exact catalog and skill material. A new card or edited
  // skill must not acquire the previous run's loads, instructions or cached personality.
  // Every-tool runs offer skills too (load_skill without deferred tools), under the same rule.
  const loads = (s: ContinuousSnapshot) =>
    s.agent?.tools.some((t) => t.deferred) === true || (s.agent?.cardSkills?.length ?? 0) > 0
  if (loads(snapshot) || loads(fresh)) {
    if (
      !isDeepStrictEqual(snapshot.agent?.tools, fresh.agent?.tools) ||
      !isDeepStrictEqual(snapshot.agent?.cardSkills, fresh.agent?.cardSkills)
    )
      return {
        reason:
          "The skills or available tools changed, so this request was put together again. A changed tool list may make it read the chat again once at full input cost."
      } as const
  }
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
    // Thinking hidden on a message this run posted lives in the carried transcript.
    extra.some(
      (e, at) => e.version.id !== produced[at] || e.contextExcluded || e.inserted || !!e.hiddenThinking?.length
    ) ||
    path.slice(index + 1).some((e) => e.side !== "user" || !e.inContext || e.inserted)
  )
    return {
      reason:
        "The chat was edited, inserted into, hidden or replaced, or thinking was hidden, after the previous run, so this request was put together again."
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
    const words = stepWords(steps)
    // The number lets read_run read them back (spec/WORKSHOP-CONTEXT.md §3.2).
    if (words.length)
      summaries[entry.version.id] =
        `[Message ${(entry.position ?? entry.depth) + 1} steps: ${words.join("; ").replaceAll(/\s+/g, " ")}]`
  }
  return summaries
})

/**
 * A message's tool steps as its summary names them. An MCP tool's label is the server's title
 * for it, so outside the data boundary only its exposed name (the app's, sanitized) stands for it
 * (spec/MCP.md §9).
 */
export const stepWords = (steps: ReadonlyArray<RolloutStep>) =>
  steps.flatMap((s) =>
    s.kind === "tool"
      ? [
          `${s.effectClass === "mcp" ? s.tool : s.label}${s.title ? `: ${s.title}` : ""}${s.status === "error" ? " (failed)" : ""}`
        ]
      : []
  )

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
 * a post's, until the model's tokenizer reaches the target. Null: the protected material
 * cannot fit the target, so build fresh. Counting batches keeps long transcripts bounded.
 */
export const elideCarried = <E>(input: {
  readonly reader: Reader["Service"]
  readonly request: GenerationRequest
  readonly path: ReadonlyArray<PathEntry>
  readonly transcript: ReadonlyArray<AgentMessage>
  readonly count: number
  readonly room: number
  readonly recount: (transcript: ReadonlyArray<AgentMessage>) => Effect.Effect<number, E>
  /** New workshop projections use only app-owned coordinates in recovery framing. */
  readonly quoteResults?: boolean
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
    let measured = count
    let elided = 0
    let pending = 0
    let batch = 1
    for (const { index, call } of candidates) {
      const message = next[index] as AgentMessage & { role: "toolResult" }
      const number = numbers.get(index) ?? null
      const marker =
        input.quoteResults && number !== null
          ? `${ELIDED} read_run with message ${number} shows it again.]`
          : elisionMarker(number, call)
      if (textOf(message.content).length <= marker.length) continue
      next[index] = {
        ...message,
        content: [{ type: "text", text: marker }],
        // A previous per-result projection must not override this new shortening.
        ...(input.quoteResults ? { details: { ...(message.details as object | undefined), sentText: marker } } : {})
      }
      elided++
      pending++
      if (pending >= batch) {
        measured = yield* input.recount(next)
        if (measured <= room * ELIDE_TARGET) return { transcript: next, count: measured, elided }
        pending = 0
        batch *= 2
      }
    }
    if (pending > 0) measured = yield* input.recount(next)
    return elided > 0 && measured <= room * ELIDE_TARGET ? { transcript: next, count: measured, elided } : null
  })
