# The desktop app, and updating it

**Status**: Proposed, 2026-11-17 (desktopspec). Nothing in this document is built. The owner's statements are in DESIGN §10.5, marked **[D]**, and are quoted here where they apply. Everything else is Proposed. It builds on [FILES-AND-ENVIRONMENT.md](FILES-AND-ENVIRONMENT.md) (the OS-native sandbox and the toolchain, which the desktop package must carry) and on what ARCHITECTURE §1–§4, §7 and §17 record as built: Node 24 running the server's TypeScript by type stripping, `node:sqlite` in one writer and a pool of reader workers, worker bundles with a stamp, the Vite client, the plugin compiler and probe children, and the single/proxy auth and exposure rules.

The owner's requirements: the app ships for Linux, Windows and macOS and has to "just work"; "something like electron"; no bundled Linux VM; the Docker server stays alongside the desktop app ([D]). And on updates ([D], 2026-11-17): "Actually, how to update it is important". So updating gets its own section (§6), covering both the desktop app and the server, and its milestone comes before any public desktop build (§10).

## 0. Summary

- **Electron is the window, and the server runs on its own official Node.** The desktop app is an Electron shell that starts the unchanged server as a child process, running on the official Node 24 binary the app ships. The server is not run on Electron's built-in Node (§2.2).
- **Measured, not assumed** (2026-11-17, dev host, §2.1). Electron 45.3.1's Node (24.22.2) has `node:sqlite` with FTS5, type stripping and worker threads, and loads Effect and sharp. But the real server crashes there at startup: the writer worker dies with SIGTRAP, from source and from the bundles alike. The same tree runs on official Node. Electron's Node also uses BoringSSL and a 4 GB pointer-compression cage shared by every thread. Plugin children re-run `process.execPath`, and under Electron that needs the RunAsNode fuse, which a hardened app turns off. A separate Node avoids all of this, and keeps the desktop on exactly the runtime the Docker image uses.
- **Tauri with a Node sidecar** would save about 100 MB of download. In exchange it has three different web engines (WebKitGTK on Linux), full-size updates only, and on Linux auto-update for AppImage only. **Node SEA with the system browser** has no window, no native folder dialog and no updater. Both are rejected (§2.3).
- **Desktop mode** is a registered auth mode, `desktop`. It listens on loopback only and signs the app's own windows in automatically with a one-time launch token, so other OS users and other local programs can't use the instance. The existing Origin and Host rules are unchanged. Use from other devices on the LAN is opt-in. It's turned on in the shell's own settings, outside the web app, as every security setting is (DESIGN §11 [D]), and it needs a password (§4).
- **Updates** (§6). The desktop app uses electron-updater: stable and beta channels, signed manifests and code signatures, and differential downloads for Windows, macOS and AppImage. It notifies by default and never restarts during a generation or any other running work. The server shows admins "version X is available" with release notes and the operator's command; a container never updates itself. On both, a database upgrade takes a backup first, runs in one transaction, and rolls back on failure, so the previous version still opens the data. Older versions open newer data whenever every migration since says they can (a compatibility marker that must ship before the first public build). Plugins are checked against the new version and turned off with a notice if they fail; they never stop the app from starting.
- **Desktop and server differ only through registered parts**: auth modes, host-shell services, data locations, update sources, command sandboxes, toolchains and plugin-check confinement (§8).
- **Milestones** (§10): U0, the update foundations in the server, comes first and can start now. Then M0, a Linux window; M1 Windows; M2 macOS; M3 desktop updates; M4 signing; M5 the toolchain fetch; M6 LAN access. The first public build needs U0, M3 and M4.

## 1. What the package must carry

| Part | Today (server, Docker) | Desktop |
|---|---|---|
| Runtime | `node:24.22.1-trixie-slim`, main thread from TypeScript source (type stripping) | The official Node 24 binary for the platform, same version as the image (§2.2) |
| Storage | `node:sqlite` with FTS5, one writer and `DB_READERS` reader workers, plus one isolated planning reader | Unchanged |
| Worker bundles | `dist/workers/{writer,reader,formats}.mjs`, refused when the stamp doesn't match | Unchanged. Built once in CI, shipped with their stamp |
| Client | Vite build in `packages/client/dist`, plus client source for editable built-in copies (§17) | Unchanged, served by the server over loopback |
| Native modules | `sharp` (N-API, platform package `@img/sharp-*` with libvips), `rolldown` (N-API binding, used by the plugin compiler), `tiktoken` (WebAssembly) | The target platform's optional packages, installed per CI job (§9) |
| Child processes | Plugin compiler, probe, test and Git children (`process.execPath`), confined by `setpriv --seccomp-filter` on Linux | Same children, on the shipped Node. Confinement on macOS and Windows comes from the new `pluginCheckConfinement` part (§8). Until it exists, plugin checks that run code are refused there, as on any non-Linux host today |
| Command sandbox and tools | FILES §3: bubblewrap/socat and the toolchain in the image | FILES §3.2, §3.4: bundled `bwrap`/`socat` static builds (Linux), Seatbelt (macOS), `rp-sandbox-win.exe` (Windows), the toolchain fetched on first use (§5) |

Measured sizes (2026-11-17):

| Item | Size |
|---|---|
| Official Node 24.22.1 download | 32.0 MB Linux x64 (`.tar.xz`), 27.5 MB macOS arm64, 37.7 MB Windows x64 (`.zip`) |
| Electron 45.3.1 download | 123.9 MB Linux x64 zip (274 MB unpacked), 121.0 MB macOS arm64, 158.4 MB Windows x64 |
| Production `node_modules` (`npm ci --omit=dev`, Linux x64) | 372 MB unpacked; 42 MB as `tar.xz`, 79 MB gzip. Not yet trimmed: the largest are effect 54 MB, openai 28 MB, `@img` 28 MB, typescript 24 MB, tiktoken 23 MB, `@base-ui` 20 MB (client-only, not needed at runtime), rolldown 19 MB, `@redis` 15 MB |

So a Linux installer would be about 200 MB to download (Electron about 100 MB compressed, Node 30, the app 45 to 80), and 700 to 800 MB installed before trimming. Trimming `node_modules` to what the server's main thread actually imports at runtime (the client's packages, and dependencies of dependencies that are never loaded) belongs to M0.

## 2. Packaging options

### 2.1 Measured: the server on Electron's Node

Electron's release table: Electron 45 (stable 2026-10-20) has Node 24.22.0, and 46 (2027-01) moves to Node 26. Measured on the dev host with Electron 45.3.1 (`ELECTRON_RUN_AS_NODE=1`, Linux x64):

- `process.versions.node` is 24.22.2, SQLite is 3.53.4, OpenSSL reports 0.0.0 (BoringSSL); `v8_enable_pointer_compression` and `v8_enable_sandbox` are both 1. Official Node has both at 0.
- Work: `node:sqlite` in memory and in a file, an FTS5 table, the whole 650-statement `baseline.ts` in WAL mode on the main thread and in a worker thread, every `DatabaseSync`/`StatementSync` call Effect's driver makes (`allowExtension`, `enableLoadExtension(false)`, `setReturnArrays`, `iterate`, `setReadBigInts`, tag stores), TypeScript type stripping in the main thread and a worker, `import("effect")`, `require("sharp")` (with sharp's own warning that Electron's Linux binaries may be incompatible), and the writer bundle starting in a worker and answering its first message.
- **Doesn't work: `packages/server/src/main.ts` itself.** It exits with SIGTRAP (status 133) before listening, from source and with the bundles alike (`DB_WORKERS=bundle`, built the same day). gdb puts the trap in the `writer.ts` thread, with no symbols. Official Node 24.15 on the same tree and data directory listens normally. The trap is V8's immediate-crash form, which in release builds prints nothing; the V8 sandbox or the shared cage are the likely causes, but the cause wasn't found in this job.

### 2.2 The choice: Electron shell, server on its own Node

The shell's main process starts `resources/node/bin/node packages/server/src/main.ts` (on Windows `node.exe`) with the desktop environment (§3), watches it, and opens windows on `http://127.0.0.1:<port>/`. Reasons to keep the server off Electron's Node, beyond the crash:

- **Plugin children.** The compiler, probe, test and Git children are spawned as `process.execPath` (`plugins/process.ts`, `processSupervisor.ts`). Under Electron that's the Electron binary, which acts as Node only with the `RunAsNode` fuse on. A hardened app turns that fuse off, because otherwise any local program can use the signed app as a signed Node interpreter.
- **One runtime everywhere.** The Docker image, native runs and the desktop all run the same official Node release. The FTS5 check in the README holds, OpenSSL is OpenSSL, and an Electron upgrade (Electron 46 brings Node 26) never changes the server's runtime.
- **Memory and limits.** No shared 4 GB cage across the main thread, readers, writer and format workers; the plugin compiler's 768 MiB heap limit stays per process.
- **The toolchain needs Node anyway** (FILES §3.4: "Electron's own Node isn't reused, since it has no npm"). The shipped binary is the same one, so the first-run fetch is 25 to 30 MB smaller, and the sandbox's Node is always the app's Node.

The cost is one more binary to sign (§7) and about 30 MB of download.

### 2.3 Compared

| | **Electron shell + Node** (proposed) | Tauri 2 + Node sidecar | Node SEA + system browser |
|---|---|---|---|
| Server unchanged | Yes, on official Node | Yes, on official Node (an `externalBin` sidecar) | Partly. SEA can't load `.node` addons from its blob, so sharp and rolldown are extracted to disk. Worker bundles and the compiler's `typescript`/`rolldown` still need files on disk, so it's a directory anyway |
| Web engine | Chromium on every OS, the same one the browser suite's `chromium` project tests | WebKitGTK (Linux), WKWebView (macOS), WebView2/Chromium (Windows): three engines, and WebKitGTK is behind the others on performance (DESIGN §10.4 [D]: performance first) | The user's browser, whatever it is |
| Download | About 200 MB (§1) | About 90 to 120 MB (shell 5 to 15, Node 30, app 45 to 80) | About 80 to 110 MB |
| Memory beyond the server | Chromium's browser and GPU processes plus the renderer: about 150 to 300 MB, of which the renderer is what a browser tab costs anyway (estimate; measured in M0) | The WebView's processes, roughly 80 to 150 MB less | A browser tab |
| Updates | electron-updater: Windows (NSIS), macOS (DMG, with the zip Squirrel.Mac needs), AppImage, deb and rpm. **Differential** downloads for NSIS, the macOS zip and AppImage (block maps); staged rollouts; the manifest Ed25519-signed (v27), and code signatures checked on Windows too | Tauri updater: signed (can't be turned off), **full bundles only**; on Linux, AppImage only | Write our own |
| Native dialogs and OS integration | Folder dialog, notifications, tray, single-instance lock, deep links | Same | None. A browser can't hand the server a folder path, so FILES §3.7's "Folder on this computer…" can't work |
| Signing | Mature tooling (electron-builder: notarytool, Azure Artifact Signing, signtool) | Mature | SEA binaries must have their signature removed and redone after injection; awkward on macOS |
| Security record | Its own (fuses, context isolation; §4.4) | DESIGN §11 cites AIRI's RCE through Tauri IPC; avoidable with no IPC exposed, which §4.4 also does in Electron | No shell to attack |

**Recommendation: Electron + the official Node.** It is what the owner named, it gives one web engine to test, and its updater is the only one with differential downloads on all three systems. Tauri's saving is download size; its costs are three engines and full-size updates. The SEA variant stays available as what it already is, `npm start` with a browser (README, "Running on a laptop").

## 3. Process layout and data

### 3.1 The shell

- **One instance per user** (`app.requestSingleInstanceLock`). A second launch focuses the running app. The server's own instance lock on `DATA_DIR` stays the guard against two servers on one data folder.
- **The server child** gets a fixed environment: `NODE_ENV=production`, `DATA_DIR`, `HOST=127.0.0.1`, `PORT`, `AUTH_MODE=desktop`, `CLIENT_DIST`, and an IPC channel (Node `fork`-style `stdio: ["ignore", "pipe", "pipe", "ipc"]`). Logs go to `<data>/logs/server-<date>.log`, rotated.
- **Starting**: the shell shows a small native "Starting…" window until `/healthz` answers, at most 60 s, then opens the app. If the server exits during startup, the shell shows its plain startup message (the server already prints one for every refusal: stale bundles, locked data folder, unsafe filesystem, a failed migration) with **Open the log** and **Quit**.
- **Stopping**: on quit the shell asks the server to stop over IPC, and the server runs its existing close path (ARCHITECTURE §2 "Stopping"). On Windows `kill("SIGTERM")` terminates the process outright, so IPC is the only clean way. After 10 s the shell kills it.
- **A crashed server** is restarted once, with a notice; a second crash within a minute shows the failure window.
- **Port**: picked at first run from a free port in 41000–48999, stored in the shell's config, and reused, so links and bookmarks keep working (memory: URL is truth). If it's taken at a later start, the shell takes another and says so in the window's notice.

### 3.2 Where data lives

| OS | App data (`DATA_DIR`) | Config, logs |
|---|---|---|
| Linux | `$XDG_DATA_HOME/<app>` (default `~/.local/share/<app>`) | `$XDG_CONFIG_HOME/<app>`; logs under `$XDG_STATE_HOME/<app>` |
| macOS | `~/Library/Application Support/<app>` | the same folder; logs in `~/Library/Logs/<app>` |
| Windows | `%LOCALAPPDATA%\<app>` (not `%APPDATA%`, which roams with the profile and would copy a live database around) | `%LOCALAPPDATA%\<app>\config`, `…\logs` |

- `FILES_DIR` defaults to `DATA_DIR/files` there (FILES §1.1), the home folder for commands to `DATA_DIR/env-home`, the toolchain to `DATA_DIR/toolchain`.
- **Moving the data folder** is a shell setting (Settings → Data folder → Move…). It stops the server, copies, checks and restarts; the old folder is kept until the user deletes it. A folder inside iCloud Drive, OneDrive, Dropbox or a network share is refused with the README's reason (syncing a live SQLite database can corrupt it). On Linux the server's own filesystem check applies; on macOS and Windows the shell checks known sync roots by path.
- **Windows specifics the server needs** (M1): long paths (`DATA_DIR/plugins/.builds/<owner>/<id>/<commit>/…` can pass 260 characters, so `\\?\` paths or a shorter build layout); renaming a directory fails while any handle to it is open (antivirus often holds one), so staging renames retry and then report; file modes (`0o600`) do nothing on NTFS, so `secret.key` gets an ACL limited to the user instead; case-insensitive paths, which the plugin path checks already handle.

## 4. Desktop mode: sign-in, exposure, the window

### 4.1 `AUTH_MODE=desktop`

A new entry in the auth modes (§8), beside `single` and `proxy`:

- **Loopback only.** `HOST` must be loopback, unless LAN access is on (§4.3).
- **Every request needs a session**, even from loopback. Without that, any other OS user on the machine, and any local program, could act as the admin through the port. (A local program running as the same user can read the data folder anyway; this protects against the others, and against browsers, below.)
- **The shell signs its windows in.** At each start the shell creates a one-time launch token, sends its hash to the server over IPC, and opens `/auth/desktop?token=…`. The server checks it, sets the ordinary `rp_session` cookie (`HttpOnly`, `SameSite=Strict`), and redirects to the app. A token works once and expires after 60 s. Sessions of the desktop account are the existing kind, kept 30 days.
- **The account** is the local admin (`local`, as today when no password is set). Setting a password is optional. It's needed only for LAN access (§4.3).
- **Open in browser** (app menu and the shell's tray menu) makes a fresh launch token and opens the same link in the user's default browser, which then has its own session. The browser tab shows the URL, as on the server.

### 4.2 Cross-site rules

Unchanged, and they hold. The window and the browser load `http://127.0.0.1:<port>`, so `Host` is an IP literal and `Origin` names that host. A page from another site that opens a WebSocket to the port is refused by Origin; DNS rebinding is refused by Host. The launch link is a GET that only sets a cookie for a valid one-time token, and `SameSite=Strict` keeps the cookie off cross-site requests. No custom `app://` scheme is used: it would change the origin, the CSP's `ws:` sources and the cookie rules for nothing.

### 4.3 Other devices on the LAN (opt-in)

- **Where**: the shell's own **Settings → Use from other devices**, a native window, not the web app. DESIGN §11 [D]: security settings are set outside the app. On the server that means the environment; on desktop it means the shell, which no web session, plugin or agent can reach.
- **What it does**: asks for a password for the account if it has none (the existing exposure rule: beyond loopback only with a password, DESIGN §11 [D]), then restarts the server listening on all interfaces, or on one the user picks. It shows the address, e.g. `http://192.168.1.20:41873`, with a QR code. Devices on the LAN sign in with the password; the desktop's own windows stay signed in by token.
- **Said plainly in the dialog**: the connection is plain HTTP, so the password and chats cross the LAN unencrypted. Use it on a network you trust, or put TLS in front as on a server. The OS's firewall asks once (Windows Defender Firewall, macOS's application firewall).
- **Off again** restarts the server on loopback; LAN sessions stop working at once, because the exposure gate refuses their addresses.

### 4.4 The window

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, and **no preload script**: the renderer is an ordinary web page, exactly the one a browser gets. Nothing in it, model HTML in a message frame included (DESIGN §10.2), can call into the shell. That removes the class of bug DESIGN §11 cites from AIRI (card HTML reaching Tauri IPC).
- **Native features go through the server.** The folder dialog for FILES §3.7 is an RPC (`PickHostFolder`); the server asks the shell over its IPC channel, the shell shows the system dialog, and the chosen path comes back. It therefore works the same from the window and from Open in browser on the same machine. The same channel carries "show in the file manager" (FILES §11) and desktop notifications.
- Navigation away from the app's origin is blocked; external `http(s)` links open in the default browser; other schemes are dropped. `window.open` to the app's own origin opens a new app window (the app is multi-tab). Permission requests are denied except clipboard writes.
- **Fuses**: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `EnableCookieEncryption` on.
- **Links**: the app menu has **Copy link** (the current view's URL) and **Open in browser**, since a window has no address bar.

## 5. First run

1. The shell creates the data folder, picks the port, starts the server.
2. The window opens on the app's existing first screen, plus a short desktop welcome: where the data lives (with **Change…**), and the update choice (§6.4, and question 1).
3. **Assistant tools** (FILES §3.4) aren't fetched at first run. They're fetched on the first command, or from Settings → Assistant tools, with progress ("Setting up the assistant's tools: 64 of 140 MB"). Each artifact is checked against the SHA-256 in the app's manifest and unpacked into `DATA_DIR/toolchain/<toolchain id>-<manifest hash>/`. The bundled Node is linked in rather than downloaded.
4. **Sandbox availability** shows on the same page: on Ubuntu 24.04 and later from an AppImage, "Commands need the .deb package, or running without a sandbox" (FILES §3.2), with the fix.
5. **Importing a SillyTavern folder** stays where it is (Import). On desktop, the import page's folder field gets the system folder dialog through `PickHostFolder`.

## 6. Updating

Updating covers six things: the mechanism, the user's control, the database, plugins, the toolchain, and what the user sees. Each covers the desktop app and the server.

### 6.1 Versions and channels

- **One version** for the app: semver, `MAJOR.MINOR.PATCH`, shown in Settings → About and in `/healthz` (a header beside `X-Client-Build`). The desktop package, the Docker image and a source checkout of the same release have the same version.
- **Channels**: `stable` and `beta`. Beta gets each release first; stable gets it after a soak. The channel is a setting (desktop: the shell; server: an admin setting). Switching from beta to stable never downgrades: the app waits until stable passes its version.
- **Where releases come from**: a release feed, a registered part (`updateSources`, §8), so a fork or a plugin can point it elsewhere. The built-in feed is the project's GitHub Releases: electron-updater's `latest*.yml` files and block maps for the desktop; images on GHCR tagged `:X.Y.Z`, `:X.Y`, `:stable` and `:beta`; and `release.json` (version, channel, date, the release notes in Markdown, the plugin API version, and the compatibility list of §6.5), signed with the project's Ed25519 release key.

### 6.2 Desktop: the mechanism

- **electron-updater** with the GitHub provider. Windows uses the NSIS target, macOS the DMG plus the zip Squirrel.Mac needs, Linux AppImage, deb and rpm.
- **Differential downloads**: NSIS and the macOS zip publish block maps, and AppImage embeds its own, so an update downloads only the changed blocks. The split in §2.2 helps: Electron and Node change rarely, so a typical release changes the app's own files and a small share of `node_modules`.
- **Verification**: the update manifest is Ed25519-signed (electron-updater 27+) and checked before downloading. The downloaded installer's code signature is checked on Windows and macOS (Squirrel.Mac refuses an unsigned or differently signed app). Linux packages: AppImage by the manifest signature; deb and rpm by GPG where the package manager supports it (`allowUnverifiedLinuxPackages: false`).
- **deb and rpm** install through the system's package manager, which always asks for the admin password. So for them, "Restart to update" first asks for it (pkexec). An APT/RPM repository, so updates also arrive through the system's updater, is later work.
- **Staged rollouts** (`stagingPercentage`) are available and used for stable releases. A release that crashes at startup on many machines can be pulled before it reaches everyone.

### 6.3 Server (Docker): the mechanism

- **The container never updates itself.** It would need the Docker socket, which FILES §3.1 rejects (the app runs full-trust plugins, and the socket is root on the host).
- **It tells the admin.** If update checks are on (§6.4, question 1), the server fetches `release.json` for its channel once a day through the `Network` service (so the instance proxy applies). Admins see a notice: "Version 1.4.0 is available. What's new · How to update", with the operator's command for this install:
  - Compose: `docker compose pull && docker compose up -d`
  - A pinned tag: change `image:` to `…:1.4.0`, then the same.
  - A source checkout: `git pull && npm ci && npm run build`, then restart. The stale-bundle refusal (ARCHITECTURE §3.6) already stops a half-updated checkout.
- **Unattended updates** (Watchtower and the like) are the operator's choice. The server's migration safety (§6.5) is what makes them safe, and it is the same either way.
- **Restart timing** is the operator's, but the notice says what's running ("2 replies are generating"), and `docker stop` waits for the existing close path.

### 6.4 The user's control

- **Settings → Updates** (desktop: the shell's settings; server: admin settings):
  - **Check for updates**: on or off (question 1 is the default).
  - **Channel**: Stable or Beta.
  - **Install**: *Ask me* (default: download in the background, then offer the restart) or *Install when idle* (restart on its own once the app is idle and no window has been used for 10 minutes).
  - **Check now**, with the result.
- **Never during work.** Before restarting, the shell asks the server whether it's busy: replies generating, agent rollouts, summary (LCM) jobs, imports and exports, plugin checks, running commands and background jobs (FILES §5), the toolchain fetch. *Install when idle* waits for none. **Restart now** lists what would stop ("1 reply is generating, 1 command is running") and offers **Restart when finished** (the default) or **Stop them and restart**. Stopping uses the existing Stop, so a stopped reply stays as a visible version, and the server's close path waits for writes in flight. Unsaved text is already persisted on the server as it's typed (DESIGN §6.2), so the restart loses none.
- **On quit**, a downloaded update installs ("Installing the update… "), as electron-updater's quit-and-install does.

### 6.5 The database across versions

The first real migration, `0002_files`, is planned (FILES §10). Until the owner declares real use, schema changes still go into `baseline.ts` with a fresh deploy (ARCHITECTURE §3.7). The rules below apply from the first public build on.

**Before migrating: a backup.**
- When the writer finds pending migrations, it first copies the database with SQLite's online backup (`node:sqlite`'s `backup()`, which Effect's driver already wraps) to `DATA_DIR/backups/<from>-to-<to>-<date>.db`. This happens before `Ready`, so no reader is open yet.
- It checks free space first: the database's size plus 10%. With less, it doesn't migrate. Startup stops with "Updating needs N GB free for a backup of your data; there's M GB", and the old version still opens the data. The operator can override (`UPGRADE_WITHOUT_BACKUP=1`, environment only).
- The last three upgrade backups are kept (setting); older ones are deleted only after a newer upgrade has succeeded. Media files and Files aren't copied: media are content-addressed and never rewritten by migrations, and Files aren't in the database.

**Migrating: all or nothing.**
- Effect's `SqliteMigrator` already runs every pending migration in one transaction (`sql.withTransaction(run)`), and SQLite's DDL is transactional. So a failure part-way rolls the whole upgrade back. Startup then stops with "This version couldn't update your data (migration 0003_x failed). Your data is unchanged", plus **Go back to version 1.3** on desktop (the previous installer is kept, §6.2).
- A migration is a list of statements and pure SQL, as the baseline is. One that has to rewrite many rows (a backfill) is split: the schema change in the migration, and the backfill as a resumable writer job afterwards, so startup never waits minutes in one transaction.
- The required test (FILES §10) opens a database made at the previous release with synthetic rows, migrates it, and compares rows and schema. From the first public build on, CI keeps one fixture database per released version and migrates each to the current one.

**Older versions opening newer data.**
- Today the writer refuses any database whose ledger holds a migration id it doesn't know ("Old databases are refused", ARCHITECTURE §3.7). That makes every update one-way, even one that only added a table.
- Proposed: each migration declares `readableFrom`, the oldest app version that can run correctly on the result. Additive changes (new tables, new nullable columns, new indexes, as in `0002_files`) keep the previous value; anything an older version would misread raises it. The writer stores the maximum in a one-row table, `schema_compat(min_app_version)`. At startup a build refuses data only when its own version is below `min_app_version`, and otherwise runs on data with migrations it doesn't know. Its operations simply never touch the new tables.
- This check has to be in the **first public build** (U0), because only builds that have it can open newer data.

**Going back to an older version.**
- **Desktop**: Settings → Updates → **Go back to version 1.3**, offered for the previous version (its installer is kept). If the data is still readable by 1.3 (`min_app_version`), it reinstalls 1.3 and nothing else changes. If it isn't, it says so first: "Version 1.3 can't read data changed by 1.4. Going back restores your data from before the update (2026-11-20 14:02). What you did since stays in a saved copy, and comes back if you update again." The current database is renamed into `backups/`, never deleted (nothing is lost, OVERVIEW), and the pre-upgrade backup is restored.
- **Server**: the operator pins the previous tag. When the data isn't readable by it, startup says so and names the backup to restore, and `npm run db:restore -- <backup>` (or the same command in the image) restores it, after moving the current database aside the same way.

### 6.6 Plugins across versions

What is built and stays (ARCHITECTURE §17): an enabled plugin is pinned to an approved commit with consent for exactly that commit. When the app's sources, lockfile or worker stamp change, startup re-runs the complete check from the verified approved commit before listening. A failure is caught, its partial activation disposed, and the plugin suspended with a notice. A suspended plugin stays off until it is explicitly enabled again, and `PLUGINS=off` starts with none. So a plugin can't stop an update from starting. Added:

- **The plugin API's version** is `@rp/plugin-api`'s semver (1.0.0 today) and the `api: 1` that every registration carries. A minor version only adds; a major one removes or changes something. Each app release supports its API major and the previous one for at least one minor release, through adapters, with the removed parts listed in `release.json`. The plugin manifest gains `api: "1.2"` (the minimum it needs), which the checker compares with the app's.
- **Before installing an update**, the running app compares every enabled plugin (the instance's and every account's) with the new release's compatibility list: the API major, removed or changed surfaces, and built-in parts that were renamed or removed, which matters to plugins that replace a built-in (`replaces: ["registry:id"]`). The update notice names the plugins that will be turned off: "2 plugins will be turned off by this update: Scene timer (uses a part this version removes)". The user can update them first, or install anyway.
- **After the update**, the existing startup recheck is the real test. A plugin that fails is suspended, with a notice: "Turned off after the update: Scene timer. It was made for an older version." with **Fix with the assistant**, which opens a workshop on that plugin's repository (DESIGN §12: the agent extends the harness; FILES §5.3). Its approval is per commit, so a fixed version needs consent again, as every commit does.
- **Replaced built-ins.** When an update changes a built-in that an enabled plugin, or an editable copy (P5), replaces, the plugin keeps running if its check passes. Its row says "The original changed in this update" with **Compare**, the P5 comparison of the saved original with the current one, which already exists. Nothing is merged on its own.
- **Browser plugins** follow the same path. Their bundles are rebuilt by the startup check against the new `/plugin-host.mjs` facade.

### 6.7 The toolchain's updates

- **Desktop**: the toolchain manifest is part of the app (FILES §3.4), so a new release can change it. After an update with a changed manifest, the new artifacts are fetched in the background when the app is idle (or when a command first needs them), into a new versioned folder beside the old one. The switch happens after every artifact is checked, at a moment no command is running. The old folder is removed after that. A failed fetch leaves the old toolchain in use and shows a retry in Settings → Assistant tools. A fix that only changes tools (a Git or Python security release) ships as an ordinary patch release whose only change is the manifest; differential updates make that a small download.
- **Server**: the toolchain is in the image and changes with it.
- The sandbox helpers (`rp-sandbox-win.exe`, the bundled `bwrap` and `socat`, the deb's AppArmor profile) are part of the package and change with it.

### 6.8 What the user sees

- **Available**: a notice in the app (desktop: also the shell's tray menu): "Version 1.4 is ready. What's new · Restart to update · Later". On the server, admins only, with How to update in place of Restart.
- **What's new** opens the release notes in the app, rendered by the app's own Markdown renderer under the existing CSP (no remote images), with the plugin warnings of §6.6 at the top when there are any.
- **After the update**: "Updated to 1.4" once, with What's new, plus any plugins turned off and any toolchain refresh in progress.
- **Failed**: a failed download retries later and shows in Settings → Updates; a failed migration shows the startup message of §6.5.

## 7. Signing and distribution

- **macOS**: the Apple Developer Program costs US$99 a year, for a person or an organization; notarization is included. The app, the bundled `node`, every `.node` addon and helper are signed with a **Developer ID Application** certificate, with the hardened runtime, then notarized (`notarytool`) and stapled. Node needs the `com.apple.security.cs.allow-jit` entitlement (and `allow-unsigned-executable-memory` for WebAssembly). Builds: arm64 and x64, as two DMGs (sharp and rolldown are per architecture; question 3). Squirrel.Mac only updates signed apps, so macOS updates need M4.
- **Windows**:
  - **Azure Artifact Signing** (formerly Trusted Signing): about US$10 a month for 5,000 signatures. Microsoft holds the key, so no hardware token is needed. Individual developers can enrol only in some countries (the US and Canada in the 2026 preview, per Microsoft Q&A); otherwise an organization can.
  - **An OV certificate** from a CA, about US$200–400 a year; since 2023 its key must live on a hardware token or a cloud HSM.
  - **SmartScreen**: no certificate type skips reputation any more (EV lost its instant reputation in 2024), so early downloads of a new signature show "Windows protected your PC" until enough people have installed it. Signing still matters: unsigned installers get that warning permanently, and more antivirus false positives.
  - The NSIS installer installs per user, needing no administrator, which also fits FILES §3.2's "no administrator anywhere".
- **Linux**:
  - **AppImage**: runs anywhere and updates itself, but can't install the AppArmor profile that bubblewrap needs on Ubuntu 24.04 and later, so commands are unavailable there until the user installs the deb or chooses no sandbox (FILES §3.2).
  - **deb** (Debian, Ubuntu): ships the AppArmor profile, and is the recommended download for Ubuntu.
  - **rpm** (Fedora, openSUSE): no user-namespace restriction there.
  - **Flatpak** is later work: its own sandbox blocks nested bubblewrap, so commands would need a different design. Snap isn't planned.
- The publisher name shown by macOS, Windows and the package metadata is the signing identity's legal name (question 2).

## 8. Desktop and server through registered parts

The shell stays thin. Everything that differs between desktop and server is a registered part on the server, which a plugin can replace (memory: self-customizable harness):

| Registry | Built-ins | What differs |
|---|---|---|
| `authModes` | `single`, `proxy`, `desktop` | Who a request is, and how the window signs in (§4.1). Today's two modes become its first entries |
| `hostShell` | `desktop` (IPC to the shell), `headless` | Folder dialog, show in file manager, notifications, open external. Headless answers "not available", and the UI uses the server's folder browser limited to `HOST_FOLDERS` (FILES §3.7) |
| `dataLocations` | `server` (environment), `desktop` (per OS, §3.2) | Default `DATA_DIR`, `FILES_DIR`, logs, toolchain folder |
| `updateSources` | `github-releases`, `none` | The feed, channels and signature key (§6.1). `none` for offline instances |
| `updateInstallers` | `electron`, `operator-notice` | Desktop installs; the server tells the admin how (§6.3) |
| `commandSandboxes`, `toolchains`, `sandboxNetwork` | FILES §3.3 | Already registered there |
| `pluginCheckConfinement` | `linux-seccomp` (today's `setpriv` filter), `macos-seatbelt`, `windows-appcontainer` | How plugin check children are denied the network. Today non-Linux is refused; on desktop the macOS and Windows entries reuse the command sandboxes' `network: "none"` |

Selection follows the same rule as the sandboxes: the first available entry for the platform, unless configured; a missing part is shown with its reason, never skipped silently.

## 9. CI build matrix

GitHub Actions, on a tag, or manually for a beta:

| Job | Runner | Output |
|---|---|---|
| build | `ubuntu-24.04` | The client build, worker bundles with their stamp, `release.json`. Platform-independent, built once and passed to every package job |
| linux-x64 | `ubuntu-24.04` | AppImage, deb, rpm |
| linux-arm64 | `ubuntu-24.04-arm` | AppImage, deb, rpm |
| mac-arm64 | `macos-15` | DMG + zip, signed and notarized |
| mac-x64 | `macos-15-intel` (or cross-built on arm64) | DMG + zip, signed and notarized |
| win-x64 | `windows-2025` | NSIS installer, signed |
| docker | `ubuntu-24.04` | Multi-arch image (amd64, arm64) to GHCR, as CI builds it today |

- Each package job downloads the official Node for its target and checks its SHA-256 against the release's `SHASUMS256.txt`. It runs `npm ci --omit=dev` for the target (`--os`/`--cpu`, so sharp's `@img/*` and rolldown's binding are the right ones), trims `node_modules` (§1), and packages with electron-builder.
- **Smoke test per package**, on its own runner: install it, start it (Linux under Xvfb), wait for health, and drive the packaged app with Playwright's Electron support: sign-in by launch token, a synthetic card import, a chat against a fake provider, a plugin check (refused cleanly where `pluginCheckConfinement` isn't built yet), sandbox availability reported, quit and clean shutdown. An **update test** installs the previous release, serves the new one from a local feed, and checks the differential download, the restart gate and the migration of a fixture database.
- Secrets (Apple, Azure, the Ed25519 release key) are only available to tag builds in a protected release environment. Pull requests build unsigned packages.
- Releases are published as drafts and promoted: beta first, then stable with a staged rollout.

## 10. Milestones

| Unit | What | Depends on |
|---|---|---|
| **U0** | Update foundations in the server, usable by Docker now: the app version (Settings → About, `/healthz`); `schema_compat` and `readableFrom` replacing the unknown-id refusal (§6.5); the backup before migrating, with the free-space check; the startup message for a failed migration; `npm run db:restore`; the migration test with per-release fixtures; `release.json` and its signature; the server's update notice and Settings → Updates (admin); the plugin API version in manifests and the pre-update compatibility check (§6.6) | FILES A0's `0002_files` is the first migration through it |
| **M0** | A Linux window: the Electron shell, the official Node child, `AUTH_MODE=desktop` with launch tokens, the port, data folders, IPC stop, crash restart, the startup window, `hostShell` with `PickHostFolder`, fuses and the window hardening (§4.4); trimmed `node_modules`; AppImage and deb, unsigned; memory measured against §2.3's estimates. Includes a short spike on the Electron-Node crash (§2.1), only to record its cause | U0 for the version |
| **M1** | Windows: the server on Windows (paths, rename retries, the secret's ACL, IPC stop; §3.2), `pluginCheckConfinement` `windows-appcontainer` (from FILES W0), the NSIS installer | M0, FILES W0 |
| **M2** | macOS: DMG + zip, the hardened runtime and entitlements (ad hoc for now), `pluginCheckConfinement` `macos-seatbelt` | M0 |
| **M3** | Desktop updates: electron-updater with channels, differential downloads, the restart gate (§6.4), What's new and the notices (§6.8), Go back to the previous version (§6.5), the update test in CI. Linux and Windows unsigned first; macOS once M4 signs | U0, M0 (M1, M2 per platform) |
| **M4** | Signing: Developer ID, notarization, Windows signing, the release environment and its secrets | M2, M1; question 2 |
| **M5** | The toolchain on desktop: the first-run and on-demand fetch, its progress, versioned folders and updates (§5, §6.7) | FILES A2, M1/FILES W1, M2/FILES M1 |
| **M6** | LAN access (§4.3): the shell setting, the password step, the QR code, the restart | M0 |
| **Public** | The first public desktop build | U0, M3, M4 (M5 and M6 can follow) |

U0 can start now, in parallel with FILES track A. M0 needs no other unit. Updates (U0, M3) and signing (M4) come before anything public, because a first build without the compatibility marker and a working updater could never be updated safely.

## 11. Questions for the owner

1. **Automatic update checks.** The README promises no update checks, telemetry or remote catalogs. Should the desktop app check for updates by default? That is one small request a day to the release feed, which reveals the machine's IP address and the version. And the server? The recommendation: desktop on, chosen on the first-run screen; server off until an admin turns it on.
2. **Signing identity and cost.** Signing costs US$99 a year for Apple, plus about US$10 a month (Azure Artifact Signing, if eligible) or US$200–400 a year (an OV certificate) for Windows. The name on the certificates appears in every install dialog and in the package metadata. Should it be signed as a person or as an organization, and which name?
3. **Platforms in the first public build.** Apple-silicon Macs, Windows x64 and Linux x64 are assumed. Should Intel Macs, Linux arm64 and Windows on ARM be in the first public build too, or later? Each costs a CI job and a smoke test; Windows on ARM also needs its own toolchain manifest.

These were decided as recommendations, not asked:
- Electron with the official Node, not Electron's own Node (§2.2).
- Desktop mode signs in by launch token, not "loopback is admin" (§4.1).
- LAN access lives in the shell's settings and needs a password (§4.3).
- Ask before restarting is the default install mode (§6.4).
- Downgrading keeps the newer database as a saved copy (§6.5).

## 12. Sources (checked 2026-11-17)

- Electron release schedule (Node and Chromium per major): https://releases.electronjs.org/schedule
- electron-builder auto-update (targets, block maps, staged rollouts, signature checks, deb/rpm): https://www.electron.build/docs/features/auto-update
- Tauri 2 updater (signed full bundles; AppImage, `.app.tar.gz`, NSIS and MSI): https://v2.tauri.app/plugin/updater/
- Azure Artifact Signing pricing (Basic 5,000 and Premium 100,000 signatures a month): https://azure.microsoft.com/pricing/details/artifact-signing/ ; individual eligibility: https://learn.microsoft.com/en-us/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident
- Node.js 24.22.1 downloads (sizes above): https://nodejs.org/dist/v24.22.1/
- Measured on the dev host: Electron 45.3.1 for Linux x64 from its GitHub release, run as Node against this branch (§2.1).

## Appendix A. Names

The repository's working name is rp-harness (README). These candidates were checked on 2026-11-17. The checks: the npm package name (`npm view`); a GitHub user or organization of that name (the API), plus repositories with the name; `.com` (Verisign RDAP), `.app` and `.dev` (Google Registry RDAP); a web and app-store search for software of that name, AI and chat apps above all; and meanings in English, Spanish, French, German, Italian and Portuguese. A registered domain may only be parked. None of these were searched in the USPTO, EUIPO or WIPO databases: a knockout search there is still needed before adopting one. No name points at a card archive, or at any gateway or proxy.

| Name | npm | GitHub account | Repos named so | .com / .app / .dev | Software or trademark conflicts | Meanings | Mark |
|---|---|---|---|---|---|---|---|
| **Talemancer** | free | free | 1 (1 star) | free / free / free | None found | "-mancer" as in necromancer: someone who works magic with tales | **clear** |
| **Skeinfold** | free | free | 0 | free / free / free | None found | A skein is a loose coil of yarn; "fold" suggests threads and branches | **clear** |
| **Fablefold** | free | free | 0 | registered / free / free | None found; "Fable" names are common among AI story apps (FableAI, Fable, Friends & Fables), so not distinctive | — | **clear** |
| **Storywick** | free | free | 2 (0 stars) | registered / free / free | None found; Storywizard is a children's AI story app (different name) | wick: a candle's wick, Old English "village" | **clear** |
| **Wyrdwick** | free | free | 0 | registered / free / free | None found | wyrd: Old English "fate"; hard to spell from hearing it | **clear** (spelling) |
| **Skeinwright** | free | free | 0 | registered / free / free | None found | A maker of threads; long, hard to spell | **clear** (length) |
| **Fablewick** | free | free | 1 (0 stars) | registered / registered / free | None found | — | **clear** (.app taken) |
| **Sablewick** | free | user exists | 1 (unrelated) | registered / free / free | None found | sable: the animal, black in heraldry; French "sable" = sand | **clear** (GitHub name taken) |
| **Footlit** | free | free | 7 (≤1 star) | registered / free / free | "Footlight" is a Mac theatre-lighting app | lit by the stage's footlights | **risky** |
| **Velluma** | free | user exists | 19 small, incl. "velluma-studio" | registered / free / registered | Small projects of the name | Close to vellum; Spanish and Italian "vello" = body hair | **risky** |
| **Lanthorn** | free | user exists | 24 (16 stars) | registered / registered / free | Lanthorn (AI supply-chain startup, London) and Lanthorn.ai (AI video analytics) | archaic "lantern" | **taken** |
| **Limelit** | free | user exists | 44, incl. `limelit-co` (446 stars) | registered / registered / free | Limelit, a company with an active open-source repository | in the limelight | **taken** |
| **Mummery** | free | free | — | registered / free / free | None found | English: "a ridiculous ceremony; pretentious show", which is pejorative | **risky** |
| **Fabula** (and other real words: Skald, Coulisse, Orrery, Proscenium, Palimpsest, Familiar, Masque, Skein, Verso, Understudy) | taken (Proscenium free) | user exists | many | all registered | Many | — | **taken** |

**The cleanest five** (the choice is the owner's):

- **Skeinfold**: soft and craft-like. It reads as threads and folds, which fits branches and parallel threads, and nothing in it limits it to roleplay, so it works for the coding agent too. Every check is clear, `.com` included.
- **Talemancer**: openly fantasy, with a story-magic feel that suits roleplay best and a general agent less. Every check is clear, `.com` included.
- **Fablefold**: friendly and bookish, like Skeinfold with a story in it. Clear apart from a parked `.com`, but "fable" names are crowded in AI story apps.
- **Storywick**: cozy, a candle by the story; easy to say and spell. Clear apart from `.com`, and two empty repositories of the name.
- **Wyrdwick**: strange and memorable, fate plus a wick. Clear apart from `.com`, but people won't spell it from hearing it.
