// Trusted commands share the RPC workflows; imported content never registers executable code.
import { Context, Effect, Layer, Schema } from "effect"
import { CurrentUser } from "@rp/shared/api.ts"
import { HistoryRejected } from "@rp/shared/historyApi.ts"
import { NotFound, ServerError } from "@rp/shared/errors.ts"
import { makeRegistry, type Registry } from "./registry.ts"
import { toServerError } from "./api/internal.ts"

export interface Command {
  readonly id: string
  readonly description: string
  readonly input: Schema.Top
  readonly output: Schema.Top
  readonly execute: (input: unknown) => Effect.Effect<unknown, unknown, CurrentUser>
}

export class Commands extends Context.Service<Commands, Registry<Command>>()("rp/Commands") {
  static readonly layer = Layer.sync(Commands, () => makeRegistry<Command>())
}

/** Validate at the command boundary as well as the typed RPC boundary. */
export const makeCommand = <I, O, E>(definition: {
  readonly id: string
  readonly description: string
  readonly input: Schema.Codec<I, unknown>
  readonly output: Schema.Codec<O, unknown>
  readonly execute: (input: I) => Effect.Effect<O, E, CurrentUser>
}): Command => ({
  ...definition,
  execute: (input) =>
    Schema.decodeUnknownEffect(definition.input)(input).pipe(
      Effect.mapError(() => new HistoryRejected({ message: `Invalid input for command ${definition.id}.` })),
      Effect.flatMap(definition.execute),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(definition.output)(value).pipe(
          Effect.mapError(() => new ServerError({ message: `Command ${definition.id} returned an invalid result.` }))
        )
      )
    )
})

/**
 * Runs a registered command. Its failures reach the caller when they're the command
 * boundary's own or among `passes` (the errors the RPC declares); anything else is logged
 * and becomes ServerError.
 */
type ErrorClass = abstract new (...args: never) => unknown

export const runCommand = <O, const C extends ReadonlyArray<ErrorClass> = []>(
  registry: Registry<Command>,
  id: string,
  input: unknown,
  output: Schema.Codec<O, unknown>,
  passes: C = [] as unknown as C
) =>
  Effect.gen(function* () {
    const command = registry.get(id)
    if (!command) return yield* new HistoryRejected({ message: `Command ${id} is unavailable.` })
    const value = yield* command
      .execute(input)
      .pipe(
        Effect.catch(
          (error): Effect.Effect<never, HistoryRejected | NotFound | ServerError | InstanceType<C[number]>> =>
            error instanceof HistoryRejected || error instanceof NotFound || error instanceof ServerError
              ? Effect.fail(error)
              : passes.some((type) => error instanceof type)
                ? Effect.fail(error as InstanceType<C[number]>)
                : toServerError(id)(error)
        )
      )
    return yield* Schema.decodeUnknownEffect(output)(value).pipe(
      Effect.mapError(() => new ServerError({ message: `Command ${id} returned an invalid result.` }))
    )
  })
