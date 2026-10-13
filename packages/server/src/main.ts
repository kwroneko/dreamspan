import { scrubProviderEnvironment } from "./providerEnvironment.ts"

scrubProviderEnvironment()
// Dynamic import makes the startup order independent of the SDK module graph.
await import("./runMain.ts")
