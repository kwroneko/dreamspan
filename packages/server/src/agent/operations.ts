import { toolResultFrame } from "./toolData.ts"
import type { RolloutEffectRecord } from "@dreamspan/shared/workshopApi.ts"
import { WriteOps } from "../db/ops.ts"
import { operationExclusions, commandExclusions } from "./exposures/exclusions.ts"
// Registered, capability-bound adapters for the same operations the UI uses.
import { AppApi, CurrentUser } from "@dreamspan/shared/api.ts"
import { Effect, Context, Schema } from "effect"
import type { TSchema } from "@earendil-works/pi-ai"
import { validateToolArguments } from "@earendil-works/pi-ai"
import { makeRegistry } from "@dreamspan/shared/registry.ts"
import { Reader, Writer } from "../db/Database.ts"
import { runCommand, makeCommand, type Command } from "../commands.ts"
import type { Registry } from "../registry.ts"
import type { RolloutTool, ToolContext, ToolOutput, WorkshopStoryRead } from "./tools.ts"
import { budgetResult, ToolInputRefused } from "./tools.ts"
import type { CapabilityRegistries } from "./capabilities.ts"

export interface OperationCallData {
  readonly userId: string
  readonly rolloutId: string
  readonly toolCallId: string
  readonly capability: string
  readonly approvalDigest?: string
  readonly expected: unknown
  failure?: string
}
export const OperationCall = Context.Reference<OperationCallData | undefined>("rp/OperationCall", {
  defaultValue: (): OperationCallData | undefined => undefined
})

/** Captured only after all of the server's RPC handlers have been installed. */
export interface OperationRuntime {
  schema?: (operation: OperationExposure["operation"]) => Schema.Top | undefined
  invoke?: (
    operation: OperationExposure["operation"],
    payload: unknown,
    ctx: ToolContext,
    call: OperationCallData
  ) => Effect.Effect<unknown, unknown>
}
export interface OperationExposure {
  readonly storyRead?: WorkshopStoryRead
  readonly id: string
  readonly operation: { readonly rpc: string } | { readonly command: string }
  readonly capability: string
  readonly effect: "read" | "library" | "setup" | "outside"
  /** Asks every time, even where the capability is Allowed (as plugin_enable does). */
  readonly approval?: "always"
  readonly label: string
  readonly explanation: string
  readonly description: string
  readonly parameters?: Schema.Top
  readonly adapt?: (args: Record<string, unknown>, ctx: ToolContext) => Effect.Effect<unknown, unknown>
  /** Optional server-built description of the prepared, owner-resolved payload; null keeps the generic one. */
  readonly describe?: (
    payload: Record<string, unknown>,
    ctx: ToolContext
  ) => Effect.Effect<Pick<import("@dreamspan/shared/agent.ts").ApprovalPrompt, "title" | "rows" | "changes"> | null, unknown>
  readonly render?: (result: unknown, args: Record<string, unknown>) => string
  readonly effects?: (result: unknown, args: Record<string, unknown>) => ReadonlyArray<RolloutEffectRecord>
  readonly summarize?: (args: Record<string, unknown>) => string
  readonly after?: (
    result: unknown,
    args: Record<string, unknown>,
    ctx: ToolContext
  ) => Effect.Effect<ToolOutput, unknown>
}
const cacheKey = (ctx: ToolContext) => `operation:prepared:${ctx.toolCallId}`
const failure = (error: unknown): ToolOutput => {
  const e = error as { _tag?: string; message?: string; reason?: string; problems?: readonly string[] }
  return {
    isError: true,
    text:
      e._tag === "StorageError" || e._tag === "RpcClientError"
        ? "The operation could not be saved. Try again."
        : e._tag === "NotFound"
          ? "That saved target is unavailable or does not match this operation. Read it again."
          : e.problems?.join("; ") || e.message || e.reason || "The operation could not be completed."
  }
}

/** Bound the entire tree, including schemas supplied by trusted plugins. */
export const boundedArguments = (value: unknown) => {
  let nodes = 0
  const visit = (v: unknown, depth: number): boolean => {
    if (++nodes > 4000 || depth > 16) return false
    if (typeof v === "string") return v.length <= 64_000
    if (v === null || typeof v === "boolean") return true
    if (typeof v === "number") return Number.isFinite(v)
    if (Array.isArray(v)) return v.length <= 200 && v.every((x) => visit(x, depth + 1))
    if (typeof v !== "object") return false
    return Object.entries(v).every(
      ([k, x]) => k.length <= 200 && !["__proto__", "constructor", "prototype"].includes(k) && visit(x, depth + 1)
    )
  }
  return visit(value, 0) && JSON.stringify(value).length <= 128_000
}

export const makeOperationTools = (capabilities: CapabilityRegistries, runtime: OperationRuntime) => {
  const entries = makeRegistry<OperationExposure>()
  const operationTools = {
    ...entries,
    register: (entry: OperationExposure) =>
      Effect.sync(() => {
        const operation = "rpc" in entry.operation ? entry.operation.rpc : entry.operation.command
        const exclusions = "rpc" in entry.operation ? operationExclusions : commandExclusions
        if (exclusions[operation]) throw new Error(`Operation ${operation} is excluded: ${exclusions[operation]}`)
        if (
          entries
            .list()
            .some(
              (other) => other.id !== entry.id && JSON.stringify(other.operation) === JSON.stringify(entry.operation)
            )
        )
          throw new Error(`Operation ${operation} already has a tool name.`)
        if (!entry.capability || !capabilities.workshopCapabilities.get(entry.capability))
          throw new Error(`Tool ${entry.id} needs exactly one registered capability.`)
      }).pipe(Effect.andThen(entries.register(entry)))
  }
  const tool = (entry: OperationExposure): RolloutTool<Record<string, unknown>> => {
    const rpc = "rpc" in entry.operation ? AppApi.requests.get(entry.operation.rpc as never) : undefined
    const schema = entry.parameters ?? rpc?.payloadSchema ?? runtime.schema?.(entry.operation)
    if (!schema) throw new Error(`Tool ${entry.id} needs a parameter schema.`)
    const document = Schema.toJsonSchemaDocument(schema)
    const parameters = {
      ...document.schema,
      $defs: document.definitions,
      additionalProperties: false
    } as TSchema
    const validate = (ctx: ToolContext, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        if (!boundedArguments(args)) return yield* Effect.fail(new Error("Arguments exceed this tool's size limits."))
        yield* Effect.try({
          try: () =>
            validateToolArguments(
              { name: entry.id, description: entry.description, parameters },
              { type: "toolCall", id: ctx.toolCallId, name: entry.id, arguments: args as never }
            ),
          catch: () => new Error("Invalid tool arguments. Use only the listed fields and stay within their limits.")
        })
        ctx.cache.delete(`operation:proof:${ctx.toolCallId}`)
        const decoded = yield* Schema.decodeUnknownEffect(schema as Schema.Codec<unknown, unknown>)(args, {
          onExcessProperty: "error"
        })
        return entry.adapt ? yield* entry.adapt(decoded as Record<string, unknown>, ctx) : decoded
      })
    return {
      ...entry,
      parameters,
      describe: (ctx, args) =>
        Effect.gen(function* () {
          const payload = yield* validate(ctx, args)
          ctx.cache.set(cacheKey(ctx), { payload, proof: ctx.cache.get(`operation:proof:${ctx.toolCallId}`) ?? null })
          const proof = ctx.cache.get(`operation:proof:${ctx.toolCallId}`) as
            | {
                chat?: {
                  title: string
                  model?: {
                    connection: import("@dreamspan/shared/providers.ts").ConnectionId
                    model: import("@dreamspan/shared/providers.ts").ModelId
                  }
                }
                storyAt?: import("@dreamspan/shared/chat.ts").StoryAt
                upTo?: number
                branchLabel?: string
                branchNaming?: import("@dreamspan/shared/branchNaming.ts").BranchNaming
                chats?: ReadonlyArray<{ id: string; title: string }>
              }
            | undefined
          // An operation without a payload (a plain list) has nothing to show here.
          const rows = Object.entries((payload ?? {}) as object)
            .filter(([label]) => !proof?.storyAt || !["chatId", "forkId", "slotId", "leaf"].includes(label))
            .map(([label, value]) => ({
              label,
              value: typeof value === "string" ? value : JSON.stringify(value)
            }))
          for (const chat of proof?.chats ?? [])
            rows.unshift({ label: "affected chat", value: `${chat.title} (${chat.id})` })
          if (proof?.storyAt)
            rows.unshift({
              label: "Story position",
              value: `Branch “${proof.branchLabel}”; through message ${proof.upTo ?? 0}`
            })
          if (proof?.chat) rows.unshift({ label: "chat", value: proof.chat.title })
          const position = proof?.storyAt
            ? {
                storyAt: proof.storyAt,
                storyScope: { branch: proof.branchNaming!, first: proof.upTo!, last: proof.upTo!, from: true }
              }
            : {}
          if (entry.capability === "generate" && proof?.chat?.model) {
            const connection = yield* ctx.reader.GetConnection({
              userId: ctx.userId,
              connectionId: proof.chat.model.connection
            })
            const model = yield* ctx.reader.GetModel({ userId: ctx.userId, modelId: proof.chat.model.model })
            rows.unshift({ label: "provider", value: `${connection.name} · ${model.key}` })
          }
          const described = entry.describe ? yield* entry.describe(payload as Record<string, unknown>, ctx) : null
          return described ? { ...described, ...position } : { title: entry.explanation, rows, ...position }
        }).pipe(Effect.mapError((error) => new ToolInputRefused(failure(error).text))),
      execute: (ctx, args) =>
        Effect.gen(function* () {
          // The committed tool result wins over names, changed state and new arguments.
          if (entry.effect !== "read") {
            const prior = yield* ctx.reader.RolloutToolReceipt({
              userId: ctx.userId,
              rolloutId: ctx.rolloutId,
              toolCallId: ctx.toolCallId
            })
            if (prior) return { ...prior, replayed: true as const }
          }
          // Check even when called directly, or after a stopped run is resumed.
          const fresh = yield* validate(ctx, args)
          const prepared = ctx.cache.get(cacheKey(ctx)) as { payload: unknown; proof: unknown } | undefined
          const next = { payload: fresh, proof: ctx.cache.get(`operation:proof:${ctx.toolCallId}`) ?? null }
          const payload = prepared?.payload ?? fresh
          if (ctx.approvalDigest && JSON.stringify(prepared) !== JSON.stringify(next))
            return { text: "The saved target changed while waiting. Read it again and ask again.", isError: true }
          if (!runtime.invoke) return { text: "Operations are unavailable in this server.", isError: true }
          const result = yield* runtime.invoke(entry.operation, payload, ctx, {
            userId: ctx.userId,
            rolloutId: ctx.rolloutId,
            toolCallId: ctx.toolCallId,
            capability: entry.capability,
            expected: prepared ?? next,
            ...(ctx.approvalDigest ? { approvalDigest: ctx.approvalDigest } : {})
          })
          const output: ToolOutput = entry.after
            ? yield* entry.after(result, args, ctx)
            : { text: entry.render?.(result, args) ?? JSON.stringify(result) ?? "Done." }
          let frame: string | undefined
          if (!entry.after) {
            try {
              frame = toolResultFrame(JSON.parse(output.text))
            } catch {
              /* Plain app prose. */
            }
          }
          // Result handlers (including plugin adapters) return data, never assertions
          // that formatting/replay already happened or app-owned recovery framing.
          const { dataOnly: _dataOnly, replayed: _replayed, frame: _frame, ...outputData } = output
          const final: ToolOutput = {
            ...outputData,
            text: ctx.formatResult ? ctx.formatResult(output.text, frame) : budgetResult(output.text),
            ...(ctx.formatResult ? { dataOnly: true as const } : {}),
            ...(frame ? { frame } : {}),
            ...(entry.effects ? { effects: entry.effects(result, args) } : {})
          }
          if (entry.effect !== "read")
            yield* ctx.writer
              .RecordRolloutEffects({
                userId: ctx.userId,
                rolloutId: ctx.rolloutId,
                toolCallId: ctx.toolCallId,
                result: final.text,
                isError: final.isError === true,
                completeOperation: true,
                ...(final.effects ? { effects: final.effects } : {})
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new Error(
                      "The operation finished, but its result could not be saved. Do not repeat it; check Changes first."
                    )
                )
              )
          return final
        }).pipe(Effect.catch((error) => Effect.succeed(failure(error))))
    }
  }
  return { operationTools, operationTool: tool }
}

/** Writer handlers keep their normal UI behavior; tool calls get a transaction with consent and undo. */
export const operationWriter = (writer: Writer["Service"]): Writer["Service"] =>
  new Proxy(writer, {
    get: (target, name, receiver) => {
      const original = Reflect.get(target, name, receiver)
      if (typeof name !== "string" || typeof original !== "function") return original
      return (payload: unknown) =>
        Effect.flatMap(OperationCall, (call) =>
          call === undefined
            ? original(payload)
            : writer
                .RunWorkshopOperation({
                  userId: call.userId as never,
                  rolloutId: call.rolloutId,
                  toolCallId: call.toolCallId,
                  capability: call.capability,
                  expected: call.expected,
                  ...(call.approvalDigest ? { approvalDigest: call.approvalDigest } : {}),
                  operation: name,
                  payload
                })
                .pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      call.failure = failure(error).text
                    })
                  ),
                  Effect.flatMap((result) => {
                    const rpc = WriteOps.requests.get(name as never)
                    return rpc
                      ? Schema.decodeUnknownEffect(rpc.successSchema)(result === null ? undefined : result)
                      : Effect.succeed(result)
                  })
                )
        )
    }
  })

/** accessHandler preserves the UI's handler, ownership, invalidations and hub events. */
export const installOperationRuntime = (runtime: OperationRuntime, commands: Registry<Command>) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const importReader = yield* Reader
    yield* commands.register(
      makeCommand({
        id: "settings.read",
        description: "Read agent-changeable settings.",
        input: Schema.Struct({}),
        output: Schema.Unknown,
        execute: () =>
          Effect.flatMap(CurrentUser, (user) =>
            Effect.map(importReader.WorkshopOperationInfo({ userId: user.id }), (info) => info.settings)
          )
      })
    )
    yield* commands.register(
      makeCommand({
        id: "settings.change",
        description: "Change one agent-changeable setting.",
        input: Schema.Struct({ key: Schema.String, value: Schema.Unknown, expectedRevision: Schema.Int }),
        output: Schema.Unknown,
        execute: (input) =>
          Effect.gen(function* () {
            const call = yield* OperationCall
            const user = yield* CurrentUser
            if (!call) return yield* Effect.fail(new Error("This command needs a workshop call."))
            return yield* writer.RunWorkshopOperation({
              ...call,
              userId: user.id,
              operation: "SetAgentSetting",
              payload: { ...input, userId: user.id }
            })
          })
      })
    )
    const context = yield* Effect.context<never>()
    const handlers = new Map<string, (payload: never, options: never) => unknown>()
    for (const [tag, rpc] of AppApi.requests) {
      if (context.mapUnsafe.has(rpc.key)) {
        handlers.set(tag, (yield* AppApi.accessHandler(tag as never) as Effect.Effect<unknown>) as never)
      }
    }
    runtime.schema = (operation) =>
      "command" in operation
        ? commands.get(operation.command)?.input
        : AppApi.requests.get(operation.rpc as never)?.payloadSchema
    runtime.invoke = (operation, payload, ctx, call) =>
      Effect.gen(function* () {
        if ("command" in operation) return yield* runCommand(commands, operation.command, payload, Schema.Unknown)
        const handler = handlers.get(operation.rpc)
        const rpc = AppApi.requests.get(operation.rpc as never)
        if (!handler || !rpc) return yield* Effect.fail(new Error("This operation is unavailable."))
        const decoded = yield* Schema.decodeUnknownEffect(rpc.payloadSchema)(payload, { onExcessProperty: "error" })
        return yield* handler(
          decoded as never,
          { client: { id: 0 }, requestId: 0, headers: {} } as never
        ) as Effect.Effect<unknown, unknown>
      }).pipe(
        Effect.provide(context), // The owner comes from storage, never from arguments or imported text.
        Effect.provideServiceEffect(
          CurrentUser,
          ctx.reader.WorkshopOperationInfo({ userId: ctx.userId }).pipe(Effect.map((info) => info.user))
        ),
        Effect.provideService(OperationCall, call),
        Effect.catch((error) => Effect.fail(call.failure ? new Error(call.failure) : error))
      )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        delete runtime.invoke
        delete runtime.schema
      })
    )
  })
