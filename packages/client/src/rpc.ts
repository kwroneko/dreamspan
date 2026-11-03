import { AppApi, type AppRpcs } from "@rp/shared/api.ts"
import { Layer } from "effect"
import { AtomRpc } from "effect/reactivity"
import { RpcClient, type RpcGroup, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"

const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`

// Inferring the RPC union from the group itself is too deep for TypeScript at this many RPCs (TS2589);
// `AppRpcs` reads it off the group's `requests` instead, as the e2e and perf clients do.
const group: RpcGroup.RpcGroup<AppRpcs> = AppApi

/** The one connection to the server. Reconnects on transient socket errors. */
export class AppClient extends AtomRpc.Service<AppClient>()("rp/AppClient", {
  group,
  protocol: RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(
      Layer.succeed(Socket.WebSocketConstructor)((address, options) => {
        if (options !== undefined && typeof options !== "string" && !Array.isArray(options))
          throw new TypeError("WebSocket client options are not supported by the browser")
        const socket = new WebSocket(address, options)
        socket.addEventListener("open", () => window.dispatchEvent(new Event("rp:connected")), { once: true })
        return socket
      })
    ),
    Layer.provide(RpcSerialization.layerJson)
  )
}) {}
