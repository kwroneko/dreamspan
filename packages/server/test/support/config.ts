import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { AppConfig, type AppConfigShape } from "../../src/config.ts"
import { ServerLive } from "../../src/server.ts"

/** A server on a random loopback port with a fresh data directory. */
export const testConfig = (overrides: Partial<AppConfigShape> = {}): AppConfigShape => ({
  host: "127.0.0.1",
  port: 40_000 + Math.floor(Math.random() * 20_000),
  dataDir: mkdtempSync(join(tmpdir(), "rp-server-")),
  dbReaders: 1,
  dbAllowNetworkFs: false,
  dbWorkers: "source",
  authMode: "single",
  authProxyHeader: "remote-user",
  allowedIps: [],
  trustedProxies: [],
  allowInsecureExposure: false,
  publicOrigins: [],
  clientDist: join(tmpdir(), "rp-no-client"),
  secretKey: Option.none(),
  secretKeyFile: Option.none(),
  keyHostBinding: true,
  ...overrides
})

export const withServer = (config: AppConfigShape) =>
  Effect.provide(ServerLive.pipe(Layer.provide(Layer.succeed(AppConfig)(config))))
