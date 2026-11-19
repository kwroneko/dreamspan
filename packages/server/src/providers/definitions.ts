// Provider defaults cross the private worker transport on each request, like assembly modules.
// They stay separate from stored overrides, so replacing a catalog never rewrites connections.
import { Context, Effect, Layer, Schema } from "effect"
import { RpcClient } from "effect/rpc"
import type { Headers } from "effect/http"
import {
  builtinProviders,
  type ProviderDefinition,
  type ProviderResolution
} from "@dreamspan/shared/providerDefinitions.ts"
import { ProviderSettings } from "@dreamspan/shared/providers.ts"
import { makeRegistry, type Registry } from "../registry.ts"

export class ProviderDefinitions extends Context.Service<ProviderDefinitions, Registry<ProviderDefinition>>()(
  "rp/providers/ProviderDefinitions"
) {
  static readonly layer = Layer.sync(ProviderDefinitions, () => makeRegistry(builtinProviders))
}

export const CurrentProviderDefinitions = Context.Reference<ReadonlyArray<ProviderResolution>>(
  "rp/providers/CurrentProviderDefinitions",
  { defaultValue: () => builtinProviders }
)

const Snapshot = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    defaults: ProviderSettings,
    cacheContract: Schema.NullOr(Schema.String),
    defaultFor: Schema.optionalKey(Schema.Array(Schema.String))
  })
)
const HEADER = "rp-provider-definitions"

export const providerDefinitionClient = <A extends object>(calls: A, definitions: Registry<ProviderDefinition>): A => {
  type Call = (...args: Array<unknown>) => Effect.Effect<unknown, unknown>
  return Object.fromEntries(
    Object.entries(calls).map(([tag, call]) => [
      tag,
      (...args: Array<unknown>) =>
        Effect.suspend(() =>
          RpcClient.withHeaders((call as Call)(...args), {
            [HEADER]: JSON.stringify(
              definitions
                .list()
                .map(({ id, defaults, cacheContract, defaultFor }) => ({ id, defaults, cacheContract, defaultFor }))
            )
          })
        )
    ])
  ) as A
}

export const providerDefinitionHandlers = <A extends object>(handlers: A): A => {
  type Call = (input: unknown, options: { readonly headers: Headers.Headers }) => Effect.Effect<unknown, unknown>
  return Object.fromEntries(
    Object.entries(handlers).map(([tag, call]) => [
      tag,
      (input: unknown, options: { readonly headers: Headers.Headers }) =>
        Effect.suspend(() => {
          const encoded = options.headers[HEADER]
          const definitions =
            encoded === undefined ? builtinProviders : Schema.decodeUnknownSync(Snapshot)(JSON.parse(encoded))
          return Effect.provideService((call as Call)(input, options), CurrentProviderDefinitions, definitions)
        })
    ])
  ) as A
}
