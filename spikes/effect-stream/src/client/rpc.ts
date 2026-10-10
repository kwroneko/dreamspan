import { Effect, Layer, Stream } from "effect"
import { AtomRpc } from "effect/reactivity"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { ChatApi, type ChatEvent } from "../shared/api.ts"

const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`

export class ChatClient extends AtomRpc.Service<ChatClient>()("ChatClient", {
  group: ChatApi,
  protocol: RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson)
  )
}) {}

// AtomRpc's `mutation` helper isn't concurrent: a second call interrupts the first.
// Starting several generations at once needs `concurrent: true`.
export const generateFn = ChatClient.runtime.fn(
  (args: { slotId: string; tokensPerSecond: number; tokens: number }) =>
    ChatClient.use((client) => client("Generate", args)),
  { concurrent: true }
)

export const stopFn = ChatClient.runtime.fn(
  (versionId: string) => ChatClient.use((client) => client("Stop", { versionId })),
  { concurrent: true }
)

export const editFn = ChatClient.runtime.fn(
  (args: { versionId: string; content: string; expectedRowVersion: number }) =>
    ChatClient.use((client) => client("EditVersion", args)),
  { concurrent: true }
)

export const touchFn = ChatClient.runtime.fn(
  (versionId: string) => ChatClient.use((client) => client("TouchVersion", { versionId })),
  { concurrent: true }
)

/** Runs the chat subscription for as long as the atom is mounted, handing each batch to `sink`. */
export const makeSubscriptionAtom = (chatId: string, sink: (batch: ReadonlyArray<ChatEvent>) => void) =>
  ChatClient.runtime.atom(
    ChatClient.use((client) =>
      client("Subscribe", { chatId }).pipe(Stream.runForEach((batch) => Effect.sync(() => sink(batch)))))
  )
