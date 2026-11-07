// The providers a new connection starts from (providerDefinitions.ts), in a group of their own:
// AppCoreApi is at TypeScript's instantiation depth (TS2589).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ProviderInfo } from "./providers.ts"

export class ProviderListApi extends RpcGroup.make(
  /** Built-in and from plugins, in picker order, each with an API type in effect. */
  Rpc.make("ListProviders", { success: Schema.Array(ProviderInfo) })
) {}
