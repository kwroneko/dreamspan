import { fileURLToPath } from "node:url"
import { Config, Context, Layer } from "effect"

const defaultClientDist = fileURLToPath(new URL("../../client/dist", import.meta.url))

const AppConfigFromEnv = Config.all({
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("PORT").pipe(Config.withDefault(8080)),
  dataDir: Config.String("DATA_DIR").pipe(Config.withDefault("./data")),
  dbReaders: Config.Int("DB_READERS").pipe(Config.withDefault(2)),
  dbAllowNetworkFs: Config.Boolean("DB_ALLOW_NETWORK_FS").pipe(Config.withDefault(false)),
  /** Bundled workers in production (see Database.ts), source everywhere else. */
  dbWorkers: Config.Literals(["source", "bundle"], "DB_WORKERS").pipe(
    Config.withDefault(process.env.NODE_ENV === "production" ? ("bundle" as const) : ("source" as const))
  ),
  /**
   * single: one implicit local user, for running on your own machine.
   * proxy: trust the user name a reverse proxy (e.g. Authelia) puts in `authProxyHeader`.
   * Only safe when the server is reachable through that proxy alone.
   */
  authMode: Config.Literals(["single", "proxy"], "AUTH_MODE").pipe(Config.withDefault("single" as const)),
  authProxyHeader: Config.String("AUTH_PROXY_HEADER").pipe(Config.withDefault("remote-user")),
  clientDist: Config.String("CLIENT_DIST").pipe(Config.withDefault(defaultClientDist)),
  /**
   * The server secret that encrypts connection secrets (secrets.ts). Optional: without
   * it, one is generated into DATA_DIR/secret.key at first start.
   */
  secretKey: Config.option(Config.Redacted("SECRET_KEY")),
  /** A file holding the server secret, e.g. a Docker secret. */
  secretKeyFile: Config.option(Config.String("SECRET_KEY_FILE"))
})

export type AppConfigShape = Config.Success<typeof AppConfigFromEnv>

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("rp/AppConfig") {
  static readonly layer = Layer.effect(AppConfig, AppConfigFromEnv)
}
