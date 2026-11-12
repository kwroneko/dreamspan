// Asking first (spec/WORKSHOP.md §3.4). Before a tool runs, its capability's standing in the
// workshop decides: Off refuses with a plain message the model also receives; Allowed runs it;
// Ask first records a pending approval (bound to the rollout, the call id and the arguments'
// digest) and waits, holding no provider request, until the user answers through
// `AnswerToolApproval`, Stop cancels the wait, or the process ends. A run the process ended is
// parked as interrupted, and the built Resume runs the call through here again: its approval row
// says whether it can have run, so a call that was only waiting asks again plainly, and one that
// may have started asks with a warning.
import { createHash } from "node:crypto"
import type { ApprovalPrompt } from "@rp/shared/agent.ts"
import type { ApprovalAnswer, CapabilityMode } from "@rp/shared/workshopApi.ts"
import { Deferred, Effect } from "effect"
import type { Reader, Writer } from "../db/Database.ts"
import { type CapabilityRegistries, resolveMode } from "./capabilities.ts"
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
const offText = (label: string) =>
  `“${label}” is turned off in this workshop, so this wasn't done. Don't try it again unless the user turns it on.`

/** Waiting calls by `<rollout>:<call>`. A rollout id is unique, so one map serves every server. */
const waiters = new Map<string, (answer: { readonly answer: ApprovalAnswer; readonly note: string | null }) => void>()
const keyOf = (rolloutId: string, toolCallId: string) => `${rolloutId}:${toolCallId}`

/** Hands an answer the server stored to the call waiting for it; false when none waits here. */
export const deliverAnswer = (rolloutId: string, toolCallId: string, answer: ApprovalAnswer, note: string | null) => {
  const waiter = waiters.get(keyOf(rolloutId, toolCallId))
  if (!waiter) return false
  waiters.delete(keyOf(rolloutId, toolCallId))
  waiter({ answer, note })
  return true
}

const clip = (text: string, max = 4000) =>
  text.length <= max ? text : `${text.slice(0, max)}… (${(text.length - max).toLocaleString("en")} more characters)`

/** The arguments as they are, one row a field: the description of a tool that has none of its own. */
const argumentRows = (args: unknown) =>
  args !== null && typeof args === "object" && !Array.isArray(args)
    ? Object.entries(args as Record<string, unknown>).map(([label, value]) => ({
        label,
        value: clip(typeof value === "string" ? value : JSON.stringify(value, null, 2))
      }))
    : [{ label: "arguments", value: clip(JSON.stringify(args)) }]

export type PermitResult = { readonly run: true } | { readonly run: false; readonly text: string }

export interface PermitInput {
  readonly tool: RolloutTool<never>
  readonly context: ToolContext
  readonly args: unknown
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
}

/**
 * Whether a call may run now. Interrupting it (Stop) while it waits cancels the approval, and
 * the call's result says it was stopped, as for any running tool.
 */
export const makePermit =
  (deps: PermitDeps) =>
  ({ tool, context, args, dangling, onWaiting }: PermitInput): Effect.Effect<PermitResult> =>
    Effect.gen(function* () {
      const { reader, writer, userId, rolloutId, registries } = deps
      if (tool.capability === undefined && IN_REPLY.has(tool.effect)) return { run: true } as const
      const grants = new Map<string, CapabilityMode>(
        (yield* reader.WorkshopGrants({ userId: userId as never, chatId: deps.chatId as never, now: Date.now() })).map(
          (g) => [g.capability, g.mode]
        )
      )
      const mode = resolveMode(registries, grants, tool.capability, tool.effect)
      const capability = tool.capability ?? `effect:${tool.effect}`
      const capabilityLabel = registries.workshopCapabilities.get(tool.capability ?? "")?.label ?? tool.label
      if (mode === "off") return { run: false, text: offText(capabilityLabel) } as const
      const digest = argsDigest(args)
      const toolCallId = context.toolCallId
      let uncertain = false
      if (dangling && !IN_REPLY.has(tool.effect)) {
        const prior = yield* reader.ToolApprovalFor({ userId: userId as never, rolloutId, toolCallId, digest })
        if (prior?.status === "allowed") {
          // Answered while the run was parked, and never started.
          yield* writer.SettleToolApproval({
            userId: userId as never,
            rolloutId: prior.rolloutId,
            toolCallId,
            status: "used"
          })
          return { run: true } as const
        }
        if (prior?.status === "denied")
          return { run: false, text: prior.note ? `${DECLINED} Their note: ${prior.note}` : DECLINED } as const
        // Only waiting before: it never ran. Otherwise it may have.
        uncertain = prior?.status !== "pending" && prior?.status !== "cancelled"
      } else if (mode === "allow") return { run: true } as const
      if (mode === "allow" && !uncertain) return { run: true } as const

      // A description that can't be worked out (a malformed call, a missing card) falls back to the arguments.
      const described = tool.describe
        ? yield* Effect.suspend(() => tool.describe!(context, args as never)).pipe(
            Effect.catchCause(() => Effect.succeed(undefined))
          )
        : undefined
      const prompt: ApprovalPrompt = {
        rolloutId,
        toolCallId,
        digest,
        capability,
        capabilityLabel,
        title: described?.title ?? `${capabilityLabel}: ${tool.id}`,
        rows: described?.rows ?? argumentRows(args),
        ...(described?.changes ? { changes: described.changes } : {}),
        uncertain
      }
      const key = keyOf(rolloutId, toolCallId)
      // Waiting before the row exists, so an answer can't arrive with no one to hand it to.
      const deferred = Deferred.makeUnsafe<{ readonly answer: ApprovalAnswer; readonly note: string | null }>()
      waiters.set(key, (answer) => Deferred.doneUnsafe(deferred, Effect.succeed(answer)))
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
      if (answered.answer === "deny")
        return { run: false, text: answered.note ? `${DECLINED} Their note: ${answered.note}` : DECLINED } as const
      yield* writer.SettleToolApproval({ userId: userId as never, rolloutId, toolCallId, status: "used" })
      return { run: true } as const
    }).pipe(
      Effect.catchTag(["NotFound", "StorageError", "RpcClientError"], () =>
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
