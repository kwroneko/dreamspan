import { ToolInputRefused } from "./tools.ts"
// Asking first (spec/WORKSHOP.md §3.4). Before a tool runs, its capability's standing in the
// workshop decides: Off refuses with a plain message the model also receives; Allowed runs it;
// Ask first records a pending approval (bound to the rollout, the call id and the arguments'
// digest) and waits, holding no provider request, until the user answers through
// `AnswerToolApproval`, Stop cancels the wait, or the process ends. A run the process ended is
// parked as interrupted, and the built Resume runs the call through here again: its approval row
// supplies uncertainty only; consent never transfers to a new run. Resume describes the
// current targets again, and a call that may have started asks with a warning.
import { createHash } from "node:crypto"
import type { ApprovalPrompt } from "@dreamspan/shared/agent.ts"
import type { ApprovalAnswer, CapabilityMode } from "@dreamspan/shared/workshopApi.ts"
import { Deferred, Effect } from "effect"
import type { Reader, Writer } from "../db/Database.ts"
import { mcpToolAllowed } from "@dreamspan/shared/mcp.ts"
import { type CapabilityRegistries, MCP_CAPABILITY, resolveMode } from "./capabilities.ts"
import { mcpHostOf, mcpStoryOn, mcpWorkshopMode } from "./tools/mcp.ts"
import type { RolloutTool, ToolContext } from "./tools.ts"

/** Classes whose calls never leave the reply: no capability, no asking (a swipe undoes them). */
const IN_REPLY = new Set(["read", "chat_state"])

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable((value as Record<string, unknown>)[key])])
        )
      : value

/** The arguments' digest an answer must name. */
export const argsDigest = (args: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(args ?? {})))
    .digest("hex")

const DECLINED = "The user declined this."
/** "Don't run it" on an interrupted MCP call (spec/MCP.md §8.3). */
const NOT_RERUN = "This was interrupted and may already have happened; it wasn't run again."
const storyOffText = (label: string) =>
  `“${label}” is turned off for this chat, so this wasn't done. Don't try it again unless the user turns it on.`
const offText = (label: string) =>
  `“${label}” is turned off in this workshop, so this wasn't done. Don't try it again unless the user turns it on.`

/** Waiting calls by `<rollout>:<call>`. A rollout id is unique, so one map serves every server. */
type Answer = { readonly answer: ApprovalAnswer; readonly note: string | null; readonly revoked?: boolean }
const waiters = new Map<
  string,
  {
    readonly chatId: string
    readonly capability: string
    /** One target of the capability (an MCP server) the wait is for. */
    readonly target?: string
    readonly settle: (answer: Answer) => void
  }
>()
const keyOf = (rolloutId: string, toolCallId: string) => `${rolloutId}:${toolCallId}`

/** Hands an answer the server stored to the call waiting for it; false when none waits here. */
export const deliverAnswer = (rolloutId: string, toolCallId: string, answer: ApprovalAnswer, note: string | null) => {
  const waiter = waiters.get(keyOf(rolloutId, toolCallId))
  if (!waiter) return false
  waiters.delete(keyOf(rolloutId, toolCallId))
  waiter.settle({ answer, note })
  return true
}

/** Off also ends current waits, including one displayed in another tab. */
export const cancelCapability = (chatId: string, capability: string, target?: string) => {
  for (const [key, waiter] of waiters) {
    if (waiter.chatId !== chatId || waiter.capability !== capability) continue
    if (target !== undefined && waiter.target !== target) continue
    waiters.delete(key)
    waiter.settle({ answer: "deny", note: null, revoked: true })
  }
}

/** The arguments as they are, one row a field: the description of a tool that has none of its own. */
const argumentRows = (args: unknown) =>
  args !== null && typeof args === "object" && !Array.isArray(args)
    ? Object.entries(args as Record<string, unknown>).map(([label, value]) => ({
        label,
        value: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }))
    : [{ label: "arguments", value: JSON.stringify(args) }]

export type PermitResult =
  { readonly run: true; readonly approvalDigest?: string } | { readonly run: false; readonly text: string }

export interface PermitInput {
  /** Dispatcher lookups must not reveal a forbidden name. */
  readonly validate?: () => string | undefined
  readonly unavailableText?: string
  readonly tool: RolloutTool<never>
  readonly context: ToolContext
  readonly args: unknown
  /**
   * The exact content this call lets in (`RolloutTool.approvalTarget`). An earlier "Allow in this
   * workshop" for the same digest allows it; the answer to this one is remembered for it alone.
   */
  readonly grantTarget?: string
  /** The call was made before a stop or a restart and had no result: it may have run. */
  readonly dangling: boolean
  /** The call starts or stops waiting, with what it will do. */
  readonly onWaiting: (prompt: ApprovalPrompt | null) => void
}

export interface PermitDeps {
  readonly registries: CapabilityRegistries
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  readonly userId: string
  readonly chatId: string
  readonly rolloutId: string
  /**
   * A story reply (spec/MCP.md §5.1): the branch's own server choices at the reply's parent
   * (`agent.mcp`), frozen with the run, decide over the account's Stories switch. Absent: a workshop.
   */
  readonly story?: {
    readonly mcpChoices: Readonly<Record<string, boolean>>
    /**
     * The branch's choices as they are now, read at each call: a server turned off since the run
     * began (a Resume's included) is off. Absent or failing: the frozen ones.
     */
    readonly choicesNow?: Effect.Effect<Readonly<Record<string, boolean>>, unknown>
  }
}

/**
 * Whether a call may run now. Interrupting it (Stop) while it waits cancels the approval, and
 * the call's result says it was stopped, as for any running tool.
 */
export const makePermit =
  (deps: PermitDeps) =>
  ({
    tool,
    context,
    args,
    grantTarget,
    dangling,
    onWaiting,
    unavailableText,
    validate
  }: PermitInput): Effect.Effect<PermitResult> =>
    Effect.gen(function* () {
      const { reader, writer, userId, rolloutId, registries } = deps
      if (tool.capability === undefined && IN_REPLY.has(tool.effect)) {
        const invalid = validate?.()
        return invalid ? ({ run: false, text: invalid } as const) : ({ run: true } as const)
      }
      const grants = new Map<string, CapabilityMode>(
        (yield* reader.WorkshopGrants({ userId: userId as never, chatId: deps.chatId as never, now: Date.now() })).map(
          (g) => [g.capability, g.mode]
        )
      )
      const resolved = resolveMode(registries, grants, tool.capability, tool.effect)
      const mode =
        resolved === "off"
          ? "off"
          : tool.approval === "always"
            ? "ask"
            : tool.approval === "rollback"
              ? "allow"
              : resolved
      const capability = tool.capability ?? `effect:${tool.effect}`
      const capabilityLabel = registries.workshopCapabilities.get(tool.capability ?? "")?.label ?? tool.label
      if (mode === "off") return { run: false, text: unavailableText ?? offText(capabilityLabel) } as const
      // An MCP server's tool (spec/MCP.md §5.1, §8.3): the server's own On or Off here decides,
      // checked at the call (it may have been turned off since the turn began). Enabling is the
      // consent: a fresh call runs. A call the app may already have sent asks first, with what
      // the ledger knows; one it never sent runs.
      let rerun: ApprovalPrompt["rerun"] | undefined
      if (tool.capability === MCP_CAPABILITY && tool.mcp) {
        const ref = tool.mcp
        const story = deps.story
        const choices = story
          ? story.choicesNow
            ? yield* story.choicesNow.pipe(Effect.orElseSucceed(() => story.mcpChoices))
            : story.mcpChoices
          : undefined
        const entry = story
          ? (yield* reader.McpStoryConnections({ userId: userId as never }))
              .filter((c) => c.id === ref.connection)
              .map((connection) => ({
                connection,
                grant: mcpStoryOn(connection, choices) ? ("allow" as const) : ("off" as const)
              }))[0]
          : (yield* reader.McpWorkshopConnections({
              userId: userId as never,
              chatId: deps.chatId as never
            })).find((e) => e.connection.id === ref.connection)
        if (!entry)
          return { run: false, text: unavailableText ?? `${ref.connectionName} isn't available here now.` } as const
        if (mcpWorkshopMode(entry) === "off")
          return {
            run: false,
            text: unavailableText ?? (story ? storyOffText(entry.connection.name) : offText(entry.connection.name))
          } as const
        const listed = entry.connection.tools.find((t) => t.name === ref.tool)
        if (!listed || !mcpToolAllowed(listed, entry.connection.use))
          return {
            run: false,
            text:
              unavailableText ??
              `${entry.connection.name}'s tool “${ref.tool}” isn't allowed now, so this wasn't done. Don't try it again unless the user allows it.`
          } as const
        const invalidCall = validate?.()
        if (invalidCall) return { run: false, text: invalidCall } as const
        if (!dangling) return { run: true } as const
        const sent = yield* reader.McpCallsFor({ userId: userId as never, rolloutId, toolCallId: context.toolCallId })
        const last = sent.at(-1)
        if (!last) return { run: true } as const
        rerun = {
          connectionId: entry.connection.id,
          connection: entry.connection.name,
          host: mcpHostOf(entry.connection),
          sentAt: last.startedAt,
          status: last.status
        }
      }
      const invalid = rerun ? undefined : validate?.()
      if (invalid) return { run: false, text: invalid } as const
      // The content's digest is part of what an answer names: an answer can't move to other content.
      const digest = argsDigest({ tool: tool.id, capability, args, ...(grantTarget ? { target: grantTarget } : {}) })
      const toolCallId = context.toolCallId
      let uncertain = rerun !== undefined
      if (rerun) {
        // Asked below, whatever an earlier answer said: the ledger is what decides.
      } else if (dangling && !IN_REPLY.has(tool.effect)) {
        const prior = yield* reader.ToolApprovalFor({ userId: userId as never, rolloutId, toolCallId, digest })
        // Only waiting before: it never ran. Otherwise it may have.
        uncertain = prior?.status !== "pending" && prior?.status !== "cancelled"
      } else if (mode === "allow") return { run: true } as const
      if (mode === "allow" && !uncertain) return { run: true } as const
      // This exact content was allowed in this workshop before (and the capability isn't Off).
      if (grantTarget && !uncertain && !rerun) {
        const remembered = yield* reader.WorkshopGrants({
          userId: userId as never,
          chatId: deps.chatId as never,
          now: Date.now(),
          target: grantTarget
        })
        if (remembered.some((g) => g.capability === capability && g.mode === "allow")) return { run: true } as const
      }

      // A missing target cannot become a different target after the user approves.
      const described = rerun
        ? ({ title: `Run “${tool.label}” again`, rows: argumentRows(args) } as Pick<
            ApprovalPrompt,
            "title" | "rows" | "changes" | "storyAt" | "storyScope" | "plugin" | "presentation"
          >)
        : tool.describe
          ? yield* Effect.suspend(() => tool.describe!(context, args as never)).pipe(
              Effect.catch((error) =>
                Effect.succeed(error instanceof ToolInputRefused ? { refused: error.message } : undefined)
              ),
              Effect.catchCause(() => Effect.succeed(undefined))
            )
          : undefined
      if (described && "refused" in described) return { run: false, text: described.refused } as const
      if (tool.describe && !described && !rerun)
        return {
          run: false,
          text: "This change couldn't be described safely. Read the item again before trying."
        } as const
      const prompt: ApprovalPrompt = {
        // Only a call on the story is bound to the asking tab's position; a library or
        // setting change can be allowed from any tab.
        ...(described?.presentation ? { presentation: described.presentation } : {}),
        ...(described?.plugin ? { plugin: described.plugin } : {}),
        ...(described?.storyAt ? { storyAt: described.storyAt } : {}),
        ...(described?.storyScope ? { storyScope: described.storyScope } : {}),
        rolloutId,
        toolCallId,
        digest,
        capability,
        capabilityLabel,
        ...(grantTarget ? { grantTarget } : {}),
        title: described?.title ?? `${capabilityLabel}: ${tool.id}`,
        rows: described?.rows ?? argumentRows(args),
        ...(described?.changes ? { changes: described.changes } : {}),
        uncertain,
        ...(rerun ? { rerun } : {})
      }
      const key = keyOf(rolloutId, toolCallId)
      if (waiters.has(key)) return { run: false, text: "This call is already waiting. Use a new call." } as const
      // Waiting before the row exists, so an answer can't arrive with no one to hand it to.
      const deferred = Deferred.makeUnsafe<Answer>()
      waiters.set(key, {
        chatId: deps.chatId,
        capability,
        ...(rerun ? { target: rerun.connectionId } : {}),
        settle: (answer) => Deferred.doneUnsafe(deferred, Effect.succeed(answer))
      })
      const answered = yield* writer
        .RequestToolApproval({ userId: userId as never, rolloutId, toolCallId, digest, capability, prompt })
        .pipe(
          Effect.andThen(Effect.sync(() => onWaiting(prompt))),
          Effect.andThen(Deferred.await(deferred)),
          Effect.onInterrupt(() =>
            writer
              .SettleToolApproval({ userId: userId as never, rolloutId, toolCallId, status: "cancelled" })
              .pipe(Effect.ignore)
          ),
          Effect.ensuring(Effect.sync(() => (waiters.delete(key), onWaiting(null))))
        )
      if (answered.revoked) return { run: false, text: unavailableText ?? offText(capabilityLabel) } as const
      if (answered.answer === "deny") {
        const declined = rerun ? NOT_RERUN : DECLINED
        return { run: false, text: answered.note ? `${declined} Their note: ${answered.note}` : declined } as const
      }
      const grantsNow = new Map<string, CapabilityMode>(
        (yield* reader.WorkshopGrants({ userId: userId as never, chatId: deps.chatId as never, now: Date.now() })).map(
          (g) => [g.capability, g.mode]
        )
      )
      if (resolveMode(registries, grantsNow, tool.capability, tool.effect) === "off")
        return { run: false, text: unavailableText ?? offText(capabilityLabel) } as const
      const consumed = yield* writer.SettleToolApproval({
        userId: userId as never,
        rolloutId,
        toolCallId,
        status: "used"
      })
      return consumed
        ? ({ run: true, approvalDigest: digest } as const)
        : ({ run: false, text: "This approval is no longer current. Ask again." } as const)
    }).pipe(
      Effect.catchTag(["NotFound", "StorageError", "RpcClientError", "ApprovalRefused"], () =>
        Effect.succeed<PermitResult>({ run: false, text: "The app couldn't check whether this is allowed. Try again." })
      )
    )

/**
 * The tools a fresh turn offers, given the workshop's grants: a capability turned Off takes its
 * tools out of the next turn's definitions (the cache breaks once), and is named in the
 * instructions. Ask first and Allowed change only execution, so the definitions stay as they were.
 */
export const offeredByGrants = <T extends { readonly capability?: string | undefined; readonly effect: string }>(
  deps: Pick<PermitDeps, "registries" | "reader" | "userId" | "chatId">,
  tools: ReadonlyArray<T>
): Effect.Effect<{ readonly tools: ReadonlyArray<T>; readonly off: ReadonlyArray<string> }> =>
  Effect.gen(function* () {
    // Story tools carry no capability: nothing to read, and their definitions stay byte-identical.
    if (!tools.some((tool) => tool.capability !== undefined)) return { tools, off: [] }
    const grants = new Map<string, CapabilityMode>(
      (yield* deps.reader
        .WorkshopGrants({ userId: deps.userId as never, chatId: deps.chatId as never, now: Date.now() })
        .pipe(Effect.orElseSucceed(() => []))).map((g) => [g.capability, g.mode])
    )
    const isOff = (tool: T) =>
      tool.capability !== undefined && resolveMode(deps.registries, grants, tool.capability, tool.effect) === "off"
    const off = [
      ...new Set(
        tools
          .filter(isOff)
          .map((tool) => deps.registries.workshopCapabilities.get(tool.capability!)?.label ?? tool.capability!)
      )
    ]
    return { tools: tools.filter((tool) => !isOff(tool)), off }
  })

/**
 * Asks the user one question about a call that isn't a tool's own permit, with the same pending
 * row, wait and answer as Ask first: a subagent that couldn't be resumed (spec/SUBAGENTS.md §8),
 * "Start the task again" or "Leave it". `allow` only when the user chose to; Stop, Off and a
 * stale answer are `deny`. Its row (and the prompt's `toolCallId`, which an answer names) is
 * `<call>:ask`; the prompt shows on the call's own step.
 */
export const askUser = (
  deps: Pick<PermitDeps, "reader" | "writer" | "userId" | "chatId" | "rolloutId">,
  input: {
    readonly toolCallId: string
    readonly capability: string
    readonly prompt: Omit<ApprovalPrompt, "rolloutId" | "toolCallId" | "digest" | "capability">
    readonly onWaiting: (prompt: ApprovalPrompt | null) => void
  }
): Effect.Effect<{ readonly allow: boolean; readonly note: string | null }> =>
  Effect.gen(function* () {
    const { writer, userId, rolloutId } = deps
    const { capability } = input
    // Its own row and answer key beside the call's: the call's permit may already have asked
    // (Resume runs a dangling call through it), and a call asks its permit question once.
    const toolCallId = `${input.toolCallId}:ask`
    const digest = argsDigest({ ask: input.prompt.title, capability, rows: input.prompt.rows })
    const prompt: ApprovalPrompt = { ...input.prompt, rolloutId, toolCallId, digest, capability }
    const key = keyOf(rolloutId, toolCallId)
    if (waiters.has(key)) return { allow: false, note: null }
    const deferred = Deferred.makeUnsafe<Answer>()
    waiters.set(key, {
      chatId: deps.chatId,
      capability,
      settle: (answer) => Deferred.doneUnsafe(deferred, Effect.succeed(answer))
    })
    const answered = yield* writer
      .RequestToolApproval({ userId: userId as never, rolloutId, toolCallId, digest, capability, prompt })
      .pipe(
        Effect.andThen(Effect.sync(() => input.onWaiting(prompt))),
        Effect.andThen(Deferred.await(deferred)),
        Effect.onInterrupt(() =>
          writer
            .SettleToolApproval({ userId: userId as never, rolloutId, toolCallId, status: "cancelled" })
            .pipe(Effect.ignore)
        ),
        Effect.ensuring(Effect.sync(() => (waiters.delete(key), input.onWaiting(null))))
      )
    if (answered.revoked || answered.answer === "deny") return { allow: false, note: answered.note }
    const consumed = yield* writer.SettleToolApproval({
      userId: userId as never,
      rolloutId,
      toolCallId,
      status: "used"
    })
    return { allow: consumed, note: null }
  }).pipe(
    Effect.catchTag(["NotFound", "StorageError", "RpcClientError", "ApprovalRefused"], () =>
      Effect.succeed({ allow: false, note: null })
    )
  )
