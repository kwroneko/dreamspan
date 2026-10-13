import { serverEnvironment } from "./serverEnvironment.ts"
import { fileURLToPath } from "node:url"
import { Config, Context, Layer, Schema } from "effect"

const defaultClientDist = fileURLToPath(new URL("../../client/dist", import.meta.url))

const AppConfigFromEnv = Config.all({
  host: Config.String(serverEnvironment.HOST).pipe(Config.withDefault("127.0.0.1")),
  /** 0 takes any free port; the startup log names it. */
  port: Config.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })), serverEnvironment.PORT).pipe(
    Config.withDefault(8080)
  ),
  dataDir: Config.String(serverEnvironment.DATA_DIR).pipe(Config.withDefault("./data")),
  dbReaders: Config.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), serverEnvironment.DB_READERS).pipe(
    Config.withDefault(2)
  ),
  dbAllowNetworkFs: Config.Boolean(serverEnvironment.DB_ALLOW_NETWORK_FS).pipe(Config.withDefault(false)),
  /** Format workers (importer/Formats.ts): how many uploads are parsed, or exports written, at once. */
  formatWorkers: Config.schema(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    serverEnvironment.FORMAT_WORKERS
  ).pipe(Config.withDefault(1)),
  /** Bundled workers in production (see Database.ts), source everywhere else. */
  dbWorkers: Config.Literals(["source", "bundle"], serverEnvironment.DB_WORKERS).pipe(
    Config.withDefault(
      process.env[serverEnvironment.NODE_ENV] === "production" ? ("bundle" as const) : ("source" as const)
    )
  ),
  /**
   * single: one implicit local user, for running on your own machine.
   * proxy: trust the user name a reverse proxy (e.g. Authelia) puts in `authProxyHeader`.
   * Only safe when the server is reachable through that proxy alone.
   */
  authMode: Config.Literals(["single", "proxy"], serverEnvironment.AUTH_MODE).pipe(
    Config.withDefault("single" as const)
  ),
  authProxyHeader: Config.String(serverEnvironment.AUTH_PROXY_HEADER).pipe(Config.withDefault("remote-user")),
  /**
   * Exposure safety (net/exposure.ts). Security settings, so configurable only here.
   * ALLOWED_IPS: addresses besides loopback that may connect in single mode.
   * TRUSTED_PROXIES: the only addresses that may connect in proxy mode (loopback when unset).
   * ALLOW_INSECURE_EXPOSURE: serve every address, without protection.
   * PUBLIC_ORIGINS: the origins the app is served at besides localhost and IP addresses,
   * e.g. https://rp.example.com behind a reverse proxy.
   */
  allowedIps: Config.Array(Schema.String, serverEnvironment.ALLOWED_IPS).pipe(
    Config.withDefault<ReadonlyArray<string>>([])
  ),
  trustedProxies: Config.Array(Schema.String, serverEnvironment.TRUSTED_PROXIES).pipe(
    Config.withDefault<ReadonlyArray<string>>([])
  ),
  allowInsecureExposure: Config.Boolean(serverEnvironment.ALLOW_INSECURE_EXPOSURE).pipe(Config.withDefault(false)),
  /**
   * Built-in login (auth/Accounts.ts). Once an account has a password, loopback needs a
   * login too, unless this is off. A security setting, so configurable only here.
   */
  loopbackRequiresLogin: Config.Boolean(serverEnvironment.LOOPBACK_REQUIRES_LOGIN).pipe(Config.withDefault(true)),
  /**
   * The first admin's password, for servers no browser reaches over loopback. Applies only
   * while no enabled admin has a password. ADMIN_USER names the account (default: the existing
   * admin, else "admin").
   */
  adminUser: Config.option(Config.String(serverEnvironment.ADMIN_USER)),
  adminPassword: Config.option(Config.Redacted(serverEnvironment.ADMIN_PASSWORD)),
  adminPasswordFile: Config.option(Config.String(serverEnvironment.ADMIN_PASSWORD_FILE)),
  publicOrigins: Config.Array(Schema.String, serverEnvironment.PUBLIC_ORIGINS).pipe(
    Config.withDefault<ReadonlyArray<string>>([])
  ),
  clientDist: Config.String(serverEnvironment.CLIENT_DIST).pipe(Config.withDefault(defaultClientDist)),
  /**
   * The server secret that encrypts connection secrets (secrets.ts). Optional: without
   * it, one is generated into DATA_DIR/secret.key at first start.
   */
  secretKey: Config.option(Config.Redacted(serverEnvironment.SECRET_KEY)),
  /** A file holding the server secret, e.g. a Docker secret. */
  secretKeyFile: Config.option(Config.String(serverEnvironment.SECRET_KEY_FILE)),
  /**
   * Keys are sent only to the hosts their credential was entered for (spec/PLUGINS.md
   * §6.1). A security setting, so it's configurable only here, outside the app: no RPC,
   * setting or agent tool can change it (owner, 2026-10-11).
   */
  keyHostBinding: Config.Boolean(serverEnvironment.KEY_HOST_BINDING).pipe(Config.withDefault(true))
})

export type AppConfigShape = Config.Success<typeof AppConfigFromEnv>

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("rp/AppConfig") {
  static readonly layer = Layer.effect(AppConfig, AppConfigFromEnv)
}
