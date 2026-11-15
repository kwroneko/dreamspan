// The public definitions remain AppApi. Application transports retain validated,
// immutable full-library responses; changed data always takes the original codec.
import { AppApi } from "./api.ts"
import { immutableJson, markParsedJson } from "./immutableJson.ts"
import { type Rpc, RpcSerialization } from "effect/rpc"
import { Layer } from "effect"

const library = [...AppApi.requests.values()].find((rpc) => rpc._tag === "GetShellLibrary")!
export const TransportApi = AppApi.omit("GetShellLibrary").add(library.setSuccess(immutableJson(library.successSchema)))
export type TransportRpcs =
  (typeof TransportApi)["requests"] extends ReadonlyMap<string, infer R extends Rpc.Any> ? R : never

// Encoding delegates unchanged. Mark only JSON-parsed response roots, lazily
// fingerprinted if the full-library codec receives them.
export const transportJson = RpcSerialization.RpcSerialization.of({
  ...RpcSerialization.json,
  makeUnsafe: () => {
    const parser = RpcSerialization.json.makeUnsafe()
    return {
      ...parser,
      decode: (data) => {
        const messages = parser.decode(data)
        for (const message of messages)
          if (
            typeof message === "object" &&
            message !== null &&
            "exit" in message &&
            typeof message.exit === "object" &&
            message.exit !== null &&
            "value" in message.exit
          )
            markParsedJson(message.exit.value)
        return messages
      }
    }
  }
})
export const TransportJson = Layer.succeed(RpcSerialization.RpcSerialization)(transportJson)
