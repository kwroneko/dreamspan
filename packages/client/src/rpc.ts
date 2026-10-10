import { AppApi } from "@rp/shared/api.ts"
import { Layer } from "effect"
import { AtomRpc } from "effect/reactivity"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"

const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`

/** The one connection to the server. Reconnects on transient socket errors. */
export class AppClient extends AtomRpc.Service<AppClient>()("rp/AppClient", {
  group: AppApi,
  protocol: RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson)
  )
}) {}
