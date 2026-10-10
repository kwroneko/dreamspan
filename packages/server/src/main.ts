import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { AppConfig } from "./config.ts"
import { ServerLive } from "./server.ts"

ServerLive.pipe(Layer.provide(AppConfig.layer), Layer.launch, NodeRuntime.runMain)
