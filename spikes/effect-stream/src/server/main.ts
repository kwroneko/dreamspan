import { createServer } from "node:http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { ChatApi } from "../shared/api.ts"
import { Generations } from "./generations.ts"
import { providerStats } from "./provider.ts"
import { Store } from "./store.ts"

const Handlers = ChatApi.toLayer(Effect.gen(function*() {
  const store = yield* Store
  const generations = yield* Generations
  return ChatApi.of({
    ListSlots: ({ chatId }) => store.listSlots(chatId),
    Subscribe: () => generations.subscribe,
    Generate: ({ slotId, tokensPerSecond, tokens }) => generations.generate(slotId, tokensPerSecond, tokens),
    Stop: ({ versionId }) => generations.stop(versionId),
    EditVersion: ({ versionId, content, expectedRowVersion }) =>
      store.editVersion(versionId, content, expectedRowVersion).pipe(
        Effect.tap((v) =>
          generations.publish({ _tag: "ContentReplaced", versionId, content: v.content, rowVersion: v.rowVersion })
        )
      ),
    TouchVersion: ({ versionId }) => store.touchVersion(versionId),
    ProviderStats: () => Effect.sync(() => ({ ...providerStats }))
  })
}))

const port = Number(process.env.PORT ?? 47100)
const seedSlots = Number(process.env.SEED_SLOTS ?? 10_000)

const RpcRoute = RpcServer.layerHttp({ group: ChatApi, path: "/rpc", protocol: "websocket" }).pipe(
  Layer.provide(Handlers),
  Layer.provide(Generations.layer),
  Layer.provide(Store.layer({ filename: process.env.DB ?? ":memory:", seedSlots })),
  Layer.provide(RpcSerialization.layerJson)
)

HttpRouter.serve(RpcRoute).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port })),
  Layer.launch,
  NodeRuntime.runMain
)
