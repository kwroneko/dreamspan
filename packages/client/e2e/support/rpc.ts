import { TransportApi, TransportJson, type TransportRpcs } from "@rp/shared/transportApi.ts"
// Setting up state for a browser test without clicking through it: the same RPCs the
// client uses, over a WebSocket carrying a session cookie.
import { Effect, Exit, Layer } from "effect"
import { RpcClient, type RpcClientError, type RpcGroup } from "effect/rpc"
import { Socket } from "effect/socket"
import type { TestServer } from "./server.ts"

export type Client = RpcClient.RpcClient<TransportRpcs, RpcClientError.RpcClientError>

// Inferring the RPC union from the group is too deep for TypeScript at this many RPCs (TS2589),
// as in the app's client (`src/rpc.ts`).
const group: RpcGroup.RpcGroup<TransportRpcs> = TransportApi

/** Logs in over HTTP, and resolves to the session cookie. */
export const loginCookie = async (server: TestServer, handle: string, password: string) => {
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password })
  })
  if (response.status !== 204) throw new Error(`login as ${handle} failed: ${response.status}`)
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!
}

/** Logs in over HTTP and runs `use` with an RPC client acting as that user. */
export const asUser = async <A>(
  server: TestServer,
  handle: string,
  password: string,
  use: (client: Client) => Effect.Effect<A, unknown>
): Promise<A> => withCookie(server, await loginCookie(server, handle, password), use)

/** Runs `use` with an RPC client acting as the user whose session `cookie` is. */
export const withCookie = async <A>(
  server: TestServer,
  cookie: string,
  use: (client: Client) => Effect.Effect<A, unknown>
): Promise<A> => {
  const program = Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`${server.url.replace(/^http/, "ws")}/rpc`)),
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor)(
            (url) =>
              new WebSocket(url, { headers: { cookie } } as unknown as Array<string>) as unknown as globalThis.WebSocket
          )
        ),
        Layer.provide(TransportJson)
      )
    )
    const client = yield* RpcClient.make(group).pipe(Effect.provide(protocol))
    return yield* use(client)
  })
  const exit = await Effect.runPromiseExit(Effect.scoped(program))
  if (Exit.isFailure(exit)) throw new Error(`RPC setup failed: ${String(exit.cause)}`)
  return exit.value
}
