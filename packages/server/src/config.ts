import { serverEnvironment } from "./serverEnvironment.ts"
import { fileURLToPath } from "node:url"
import { Config, Context, Layer, Schema } from "effect"

const defaultClientDist = fileURLToPath(new URL("../../client/dist", import.meta.url))

const AppConfigFromEnv = Config.all({
  plugins: Config.String(serverEnvironment.PLUGINS).pipe(
    Config.withDefault("on"),
    Config.map((value) => value !== "off")
  ),
  host: Config.String(serverEnvironment.HOST).pipe(Config.withDefault("127.0.0.1")),
  /** 0 takes any free port; the startup log names it. */
  port: Config.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })), serverEnvironment.PORT).pipe(
    Config.withDefault(8080)
  ),
  updateCheck: Config.Literals(["on", "off"], serverEnvironment.UPDATE_CHECK).pipe(Config.withDefault("on")),
  updateCheckIntervalMs: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 60_000, maximum: 2_147_483_647 })),
    serverEnvironment.UPDATE_CHECK_INTERVAL_MS
  ).pipe(Config.withDefault(1_800_000)),
  updateRemote: Config.String(serverEnvironment.UPDATE_REMOTE).pipe(Config.withDefault("origin")),
  updateBranch: Config.String(serverEnvironment.UPDATE_BRANCH).pipe(Config.withDefault("master")),
  dataDir: Config.String(serverEnvironment.DATA_DIR).pipe(Config.withDefault("./data")),
  /** Every account's Files (spec/FILES-AND-ENVIRONMENT.md §1.1); empty: DATA_DIR/files. */
  filesDir: Config.String(serverEnvironment.FILES_DIR).pipe(Config.withDefault("")),
  /**
   * The command sandbox to use (sandbox/registry.ts), e.g. `linux-bwrap`; empty: the first
   * available for this platform. A security setting, so configurable only here.
   */
  commandSandbox: Config.String(serverEnvironment.COMMAND_SANDBOX).pipe(Config.withDefault("")),
  /**
   * Folders on the server an admin may choose as a workshop's working folder, besides Files
   * (spec/FILES-AND-ENVIRONMENT.md §3.7): absolute paths, comma-separated. Empty: none. A
   * security setting, so configurable only here; files/hostFolders.ts refuses system folders
   * and the app's own.
   */
  hostFolders: Config.Array(Schema.String, serverEnvironment.HOST_FOLDERS).pipe(
    Config.withDefault<ReadonlyArray<string>>([])
  ),
  /**
   * `1`: an admin may turn the sandbox off for a workshop, after a consent (§3.7). Commands then
   * run as the app's user. Never offered to other accounts.
   */
  allowUnsandboxedCommands: Config.String(serverEnvironment.ALLOW_UNSANDBOXED_COMMANDS).pipe(
    Config.withDefault(""),
    Config.map((value) => value === "1" || value === "true")
  ),
  /**
   * Each account's Files quota by default (spec/FILES-AND-ENVIRONMENT.md §1.2): files, their
   * versions and the home folder together. Bytes, or a number with K, M, G or T (binary units,
   * e.g. `10G`); checked at startup (files/quota.ts). An admin can set another per account.
   */
  filesQuota: Config.String(serverEnvironment.FILES_QUOTA).pipe(Config.withDefault("10G")),
  /**
   * The server's public addresses (IPs, CIDR ranges or host names) that commands may not
   * reach, besides its own interfaces' and those PUBLIC_ORIGINS' hosts resolve to. Behind NAT
   * the public address isn't on any interface (sandbox/network.ts).
   */
  publicAddresses: Config.Array(Schema.String, serverEnvironment.PUBLIC_ADDRESSES).pipe(
    Config.withDefault<ReadonlyArray<string>>([])
  ),
  dbReaders: Config.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), serverEnvironment.DB_READERS).pipe(
    Config.withDefault(2)
  ),
  dbAllowNetworkFs: Config.Boolean(serverEnvironment.DB_ALLOW_NETWORK_FS).pipe(Config.withDefault(false)),
  /** A wait between the shell's background parts (db/Database.ts `storeStaleParts`); tests hold a pass half done with it. */
  shellPassPauseMs: Config.schema(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    serverEnvironment.SHELL_PASS_PAUSE_MS
  ).pipe(Config.withDefault(0)),
  /** Format workers (importer/Formats.ts): how many uploads are parsed, or exports written, at once. */
  formatWorkers: Config.schema(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    serverEnvironment.FORMAT_WORKERS
  ).pipe(Config.withDefault(1)),
  /** Thumbnail workers (importer/Formats.ts): how many thumbnails are made at once, apart from the format workers. */
  thumbnailWorkers: Config.schema(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    serverEnvironment.THUMBNAIL_WORKERS
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
   * Both take IPs, CIDR ranges and host names, kept resolved (net/addressSet.ts).
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
  /** Where the import page's folder browser starts, and its path field's first value: the home folder when unset. */
  importStartDir: Config.option(Config.String(serverEnvironment.IMPORT_START_DIR)),
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
  keyHostBinding: Config.Boolean(serverEnvironment.KEY_HOST_BINDING).pipe(Config.withDefault(true)),
  /**
   * `on` lets admins add MCP servers that are local programs (spec/MCP.md §2.2), run in the
   * command sandbox. A security setting, so only here, outside the app; default off.
   */
  mcpLocalPrograms: Config.String(serverEnvironment.MCP_LOCAL_PROGRAMS).pipe(
    Config.withDefault("off"),
    Config.map((value) => value === "on")
  )
})

export type AppConfigShape = Config.Success<typeof AppConfigFromEnv>

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("rp/AppConfig") {
  static readonly layer = Layer.effect(AppConfig, AppConfigFromEnv)
}
