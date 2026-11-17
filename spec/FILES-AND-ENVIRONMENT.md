# Files and the agent's environment

**Status**: Proposed, 2026-11-17 (filesspec). Partly implemented (sandbox1, 2026-11-17): the server half of A0, L0, A2's core and A1's file tools, documented in ARCHITECTURE §18 with their deltas (bubblewrap driven directly instead of sandbox-runtime, a Node bridge instead of `socat`, a promise-based seam). For those parts, ARCHITECTURE §18 is the record and this text is obsolete. Also built (filesui1, 2026-11-17): most of B1, the Files tab and page with upload, new folder, rename, delete, download and copy path, and the upload, raw, list, folder, move and delete routes, recorded in ARCHITECTURE §5 "Files: the file manager" (deltas: the page's place is `/files?path=&file=`; delete asks first and is permanent until the bin holds files; no Move to…, New file, folder zip download or live refresh yet). Everything else here is unbuilt. The owner's statements are in DESIGN §7.9, marked **[D]**, and are quoted here where they apply. Everything else is Proposed. It changes one choice in [WORKSHOP.md](WORKSHOP.md) §1.2 ("No shell"). It is written as deltas from reference-harness `latest` (`src/sandbox/`, `src/tools/bash.ts`, `src/tools/file.ts`, attachment enrichment, ARCHITECTURE §7a/§11a/§11c there) and from the built workshop, plugin and attachment machinery (ARCHITECTURE §12 "Message images", §16, §17).

**The sandbox is the centre.** It is the app's first platform-specific component. The app will also ship as a desktop app for Linux, Windows and macOS, and the sandbox has to "just work" there (owner [D]). So it can't rely on Docker. The owner rejected bundled Linux VMs ([D]: "This is never going to be acceptable. Forget about it"), which rules out WSL2, Lima and Virtualization.framework, Firecracker and krun, and gVisor; none of them is considered further. The design is OS-native sandboxing on each platform, tools the app ships or fetches itself, one replaceable platform seam, and a host-folder mode that can also run without a sandbox (§3).

## 0. Summary

- **Every account has Files**: folders and files of any type in an ordinary directory tree that the app manages. The user uploads into it, including whole folders by drag and drop, and creates and organizes files there. Files open in viewers in the app: a text and code editor, images, video, audio, PDF and Markdown. Any other type downloads. Deleting goes to the bin and has Undo. Every app-side change keeps the earlier content as a version. Files are private to their owner unless shared (§1).
- **A workshop works in a folder**, as a coding agent does. It starts at the top of the user's Files. A **working-folder chip** in the composer's strip, beside the model and preset chips, changes it at any time. The choice is remembered per character card. The folder is only a starting point: the sandbox is the boundary, not the folder (§2).
- **Commands run in an OS-native sandbox**: bubblewrap on Linux and Seatbelt on macOS, both through Anthropic's open-source sandbox runtime (Apache-2.0, an embeddable npm library). On Windows, an AppContainer with a job object, which needs no administrator. Each command is a fresh sandboxed process that sees only its account's Files, a persistent home folder, the app's tools and a read-only copy of the app's source. The server runs the same Linux sandbox inside its existing container: no Docker socket, no extra service (§3).
- **The tools are the app's own**: Node, Python, Git, a shell and ripgrep, at pinned versions. They are part of the server image, and the desktop app fetches them once on first setup (about 150 MB on Windows), checked by SHA-256. Nothing has to be installed on the user's machine (owner [D]) (§3.4).
- **Network is on by default.** Commands reach the public internet and nothing private: not the app, the LAN, loopback or metadata addresses (§3.5).
- **Host folders and no sandbox**: the desktop user, and a server admin where the operator allows it, can choose a folder outside Files, and can turn the sandbox off for a workshop after an explicit consent. That works like Claude Code. Regular server accounts never get either (§3.7).
- **Consent**: the sandbox's network is not a provider send. The app sends nothing through it, and no keys are inside. File contents reach a model only in a run the user submitted, to that workshop's chosen model (§4).
- **Agent tools**: `bash` with timeouts, output paging and background commands; `read_file`, `write_file`, `edit_file`, `list_files` and `search_files`. The file tools run in the app and work even where commands can't. Plugin authoring works on a working copy in `Files/Plugins/<id>`, and Check and consent are still required to turn anything on (§5).
- **Attachments of any type**: in a workshop, an attachment is saved as a file in the working folder automatically. The message tells the model its path, in the shape reference-harness uses, and images also go as image blocks to vision models. Story chats keep today's images-only behaviour unless the owner says otherwise (question 1) (§6).
- **Changes and Undo**: every file the agent wrote through a file tool has Undo. A command's file changes are listed, with **Restore** for each file the app holds an earlier copy of. What a command did outside Files can't be taken back, and its row says so (§7).
- **Build plan**: the sandbox, folders and agent tools come first and need no file-manager UI. The file-manager UI is a parallel track that blocks nothing (owner [D]). Linux comes first: the server and a development server run it today (§9).
- **Baseline**: `baseline.ts` stays as it is. One additive migration, `0002_files`, adds two tables and four columns (§10).

## 1. Files

### 1.1 Storage

- **A real directory tree.** Each account's files live in `FILES_DIR/<userId>/`. `FILES_DIR` defaults to `DATA_DIR/files` on the server and to a folder in the app's data on desktop. The tree on disk is the truth, because commands change it directly. The database holds no file tree. It holds versions, shares and references (§10).
- **Paths are the names.** Messages, drafts, the card-folder memory and shares refer to files and folders by path. Each also records the folder's or file's inode. Renames and moves made in the app update every stored reference in the same operation. A rename made by a command is found by inode on the next lookup. If the inode is gone too, the reference says it can't find the file ("Folder not found: thesis. Choose another.").
- **The app never follows links.** Commands can create symbolic links, FIFOs and other special files in the tree. A link such as `x -> ../../secret.key` would point the app's own process at its data. Every app-side access therefore walks the path one component at a time. Each directory is opened with `O_DIRECTORY | O_NOFOLLOW`, and the next name is opened through `/proc/self/fd/<fd>/<name>`, again with `O_NOFOLLOW`. The final file is opened with `O_NONBLOCK`, and anything that `fstat` doesn't report as a regular file is refused. Lists show links and special files with their kind, and nothing opens them. Inside the sandbox, links behave normally, since they can only reach what the sandbox itself can see. This walk is shared by the file tools, the HTTP routes and the viewers (`files/safePath.ts`). It never runs SQLite, so it stays on the main thread's async file I/O.
- **Uploads** go through HTTP, as image uploads do today (`POST /files/upload`): streamed, authenticated, at most 4 GiB per file by default (an instance setting), written to a temporary name and then renamed. Dropping a folder keeps its subfolders. In the browser this uses `DataTransferItem.webkitGetAsEntry`, and the folder picker uses `webkitdirectory`. When a name is already taken, the user chooses Keep both (adds " (2)"), Replace (the old content becomes a version) or Skip, once for the whole batch.
- **Serving** (`GET /files/raw`): only to the owner or an account the folder is shared with. It supports Range requests for video and audio, and sends `nosniff`, `Cache-Control: private, no-store` and `Content-Security-Policy: sandbox; default-src 'none'`. HTML, SVG, XML and unknown types are always sent as `Content-Disposition: attachment`. A file the user uploaded can never run script on the app's origin. This uses the same headers the saved-media route uses (ARCHITECTURE §12).

### 1.2 Quotas

- **Per account**, an instance default (20 GiB proposed), changeable by an admin per account through the `settings` table. Usage counts the files, their versions, the bin and the account's home folder (§3.6).
- **Soft enforcement.** App-side writes and uploads check the quota before writing. Commands can't be stopped mid-write without filesystem quotas. After each command and every 10 minutes, the app measures usage. Over the quota, it first trims versions older than 7 days, then refuses new uploads, file-tool writes and commands, with a message saying how much to free and where ("Your files use 21.3 GB of 20 GB. Empty the bin or delete files to run commands again."). Reads, downloads and deleting still work.
- **Hard limits** are an operator option for later: one ZFS dataset or XFS project per account, with a real quota (Later, §11).

### 1.3 Versions, bin and Undo

- **Versions.** Before any app-side write replaces or removes a file's content, its previous content is stored as a version. App-side writes are uploads that replace, editor saves, file-tool writes and edits, and deletions. After a command, the app also stores the new content of each file the command changed (§7.2). So the app holds a copy of almost every state a file has been in. Content goes into the existing content-addressed media store (`media_assets`, deduplicated by SHA-256, with the existing sweep holds), and a `file_versions` row records path, origin, actor and, for an agent's change, the rollout and tool call (§10). Retention: 30 days, and the newest version of a deleted file until its bin item is emptied. Under quota pressure the oldest go first.
- **Bin.** Deleting in the app moves the file or folder to `FILES_DIR/.bin/<userId>/<binItemId>/`, outside the mounted tree, with a `bin_items` row of kind `file` (an existing registry; no schema change). Restore puts it back at its path, or at "name (restored)" when that path is taken. Purge frees the space. Deleting by command (`rm`) bypasses the bin. Only versions recover such a file (§7.2).
- **Undo.** Every app-side file operation (rename, move, delete, upload, save) shows the existing Undo toast. Delete's Undo restores from the bin, and the others reverse the operation. The Undo is refused when the file has changed since, and says so ("Changed since. Open its versions."). A viewer's ⋯ menu has **Versions**, which lists the versions with time, origin ("Uploaded", "Saved by you", "Edited by the assistant", "After a command") and Restore. Restoring is itself a new version, so it can be undone.

### 1.4 Ownership and sharing

- **Private by default** (DESIGN §11 [D]: users are never assumed trusted). No account, admin included, can list, open or mount another account's files without a share. There is no admin file browser.
- **Sharing a folder** with named accounts gives either **Can view** or **Can edit** (a `file_shares` row, §10). A shared folder appears for the other account under `Files/Shared/<owner name>/<folder>`. Their sandbox binds it at the same path, read-only for Can view. The owner's quota pays for it. Versions and Undo record the account that acted. The owner can stop sharing at any time. Their next command no longer sees it; commands already running keep it until they end. A file can't be shared on its own, only through its folder. Instance-wide sharing is Later.

## 2. Where the agent works

### 2.1 The working folder

- **Default: the top of the user's Files** (owner [D]: "we would probably have its top folder by default. I don't see how else this works. Then the user can at any time change its working directory.").
- **No per-folder wall** (owner [D]: "I am not sure if we need to specifically restrict agents from operating outside their assigned folder, I think this needs to be justified, since the environment as a whole is sandboxed."). The working folder is where commands start and where relative paths resolve. The agent can read and change any of its owner's Files, and folders shared with them as the share allows. **No confinement is proposed.** These cases were weighed, and none justifies one:
  - *Provider consent.* A file reaches the workshop's model only when the agent reads it during a run the user submitted, and the user chose that model for that workshop. That is the same rule as the workshop's other tool results (§4). Confining the folder wouldn't change who the content goes to.
  - *Accidental damage.* File-tool changes have Undo, and changes made by commands have Restore from versions (§7). A wall wouldn't stop a command in the working folder from damaging that folder either.
  - *Other users.* Separating accounts is a different matter, and it stays required. It is enforced by mounts: an account's sandbox contains only its own tree and the folders shared with it (§3.6). The file tools check the same ownership in the app.
  - If a real need appears later, a folder flag such as "The assistant can't see this" could be added as a mount exclusion. It is not proposed now.
- **Where it's stored.** The working folder is a branch-owned state key, `workshop.folder { path, inode }`, registered in `@rp/shared/state.ts` and written as a state event at the branch's current position, like the This chat settings (DESIGN §3.4). This follows the existing rules:
  - A reply uses the folder in effect before it (causal order).
  - A new branch inherits the folder as of its fork point.
  - Changing it on one branch never changes another (DESIGN §3.2 [D]).
  - Swiping or regenerating a reply keeps the folder that was in effect at that point.
- **What the model is told.** At the start of a turn the folder is in the turn's tail note, as "Working folder: /files/thesis". It is never in the system prompt, so changing it doesn't break the prompt cache. The note changes only on a turn after the folder changed. A command's `cd` lasts for the rest of that run. The `bash` tool tracks the shell's directory after each call, and Resume restores it from the transcript. Each new turn starts again in the branch's working folder.

### 2.2 The working-folder chip (owner [D]: "we have space next to model and preset")

- **Placement, as the code has it today.** The composer's strip under the box is `StripRow` (`features/chat/nextReplyStrip.tsx`). Its chips are registered in `composerControls` with `placement: "strip"`, in this order: model (10), preset (20), cache (30), the workshop capability chip (35, workshops only), then Next (40) and Reply now (50), which are hidden in workshops. The folder chip registers at **order 25**, available only in workshops (`kindShows`, as the capability chip is). It sits after **Model** and **Preset** and before the cache chip: `Model · Preset · Folder · Cache · Can: 6`.
- **At 1440 px** the strip wraps where there's room. Chips use the shared `chipClass`: 36 px high, `sm:max-w-80`, with a long name cut by an ellipsis and the whole text in the tooltip. The chip shows a folder icon and the folder's name, or "All files" at the top. Its hover explanation reads "Where the assistant's commands start. It can still reach all your files." It shows the folder's name, not the full path, so it stays short. The popover shows the full path.
- **At 390 px** (`compact`) the strip is one row that scrolls sideways, with faded edges where more chips are past them. On a phone a chip keeps its whole text. The folder chip is third, so it is visible without scrolling on a 390 px phone when the model and preset names are short, and reachable by scrolling when they're long. Its text is only the folder's last name, so it never gets wide.
- **The popover**, the strip's usual full-width-row popover at every width: the current full path; **Recent** (the last 5 folders this account picked); a folder tree starting at the top of Files, opened one level at a time, with Shared under it; **New folder here**; and **Use the top of Files**. Choosing one writes `workshop.folder` on this branch. That needs no file-manager UI: the tree is a list read through `ListFiles` (§9, track A). These choices are visible controls with hover explanations, with no key combination needed (memory: visible affordances). The implementing job checks the chip and popover with the layout audit at 1440 and 390 in both themes before merging.
- **When the folder is gone** (deleted or renamed outside the app, and not found by inode), the chip shows the warning tone with "Folder not found". The next turn starts at the top of Files and the tail note says so.

### 2.3 Remembered per character card (owner [D]: "So the same character gets the same folder preselected.")

- **Storage.** A user setting, `workshop.cardFolders`, in the `settings` table: a map from card entity id to `{ path, inode, at }`, at most 2,000 entries, with the oldest dropped first. It is a setting of the user, not part of the card: a card export or a shared card never carries a server path, and editing the card doesn't make a revision. No schema change.
- **Written** when the user picks a folder with the chip, for the workshop's assistant card on that branch, which is the card that replies. Moves made by the agent's commands never write it.
- **Read** when a workshop is created. The new workshop's first `workshop.folder` is the card's remembered folder. A card made with Make a variant has no entry of its own until the user picks one, so it uses the entry of the card it came from.
- **No card.** A workshop without an assistant card uses the account's last picked folder (`workshop.lastFolder`, also a setting), else the top of Files.
- **Branches.** The memory only chooses the starting folder of a new workshop. It never changes a folder already set on any branch. Swapping the assistant card in an existing workshop doesn't change the folder silently, since nothing changes silently. The chip still shows the branch's current folder, and its popover offers "Use <card>'s folder: /files/thesis" as the first row when the two differ.

## 3. The sandbox

### 3.1 Requirements, and the delta from reference-harness

What the sandbox has to do (owner [D]):

- work on Linux, macOS and Windows desktops and on the Docker server, with no setup and no administrator;
- give the agent Node, Python, Git and a shell even when the machine has none;
- keep the files and the work between sessions;
- allow network access by default.

| reference-harness `latest` | Here | Why |
|---|---|---|
| One long-lived Docker container per agent, with the harness driving `docker exec` over a mounted socket; off by default | **No container.** Each command is a fresh OS-sandboxed process (§3.2). The persistent environment is the account's Files plus a home folder, so there's nothing to start, stop or recreate | Docker isn't available on a desktop. A socket would make the app (which runs full-trust plugins) root on the host |
| Workspace bind-mounted; in-process file tools with string path checks | Files mounted into the sandbox; app-side file tools use a no-follow component walk (§1.1) | Commands can plant links; the app must never follow one into its data |
| A dedicated bridge plus a host `DOCKER-USER` firewall sidecar | A filtering proxy in the app process: the sandbox has no network of its own except through it (Linux, macOS), or AppContainer capabilities (Windows) (§3.5) | Works without root, on every platform |
| `timeout` wrapper and an out-of-band marker kill inside the container | The app owns the sandboxed process tree: a process-group kill (Linux, macOS) or a job object (Windows) | The process is the app's child; nothing to reach into |
| Byte-capped output at a UTF-8 boundary | Taken, plus full output kept by the app and paged (§5.1) | — |
| A full dev-toolchain image built by the operator | A pinned toolchain the app ships or fetches (§3.4) | No operator step; the same versions everywhere |

### 3.2 One sandbox per platform

| | Linux (desktop, native server, inside the server's container) | macOS | Windows |
|---|---|---|---|
| **Mechanism** | bubblewrap: new user, mount, PID, IPC and network namespaces; a seccomp filter. Driven by `@anthropic-ai/sandbox-runtime` (`SandboxManager.wrapWithSandbox`) | Seatbelt (`sandbox-exec` with a generated profile), through the same library | **AppContainer** (a process token with an AppContainer SID and chosen capabilities) inside a **job object**, launched by a small native helper the app ships (`rp-sandbox-win.exe`) |
| **Files it can reach** | Only what is bound in: the account's Files at `/files`, the home folder at `/home/user`, the toolchain and system directories read-only, `/app-source` read-only. App data isn't there at all | Seatbelt rules: write only the Files folder, home folder and temp; reads denied for the app's data folder, the user's home (except those), keychains and `.ssh` | Only objects whose ACLs grant the AppContainer SID or "all application packages". System folders are readable that way; the user's profile is not. The app adds ACEs for the account's Files, home and toolchain folders. The user owns those folders, so no administrator is needed |
| **Network** | No network namespace route out; traffic goes through the app's proxy over Unix sockets bound into the sandbox | The profile allows only the proxy's localhost port | The `internetClient` capability without `privateNetworkClientServer`: public internet, no LAN. Loopback is denied to AppContainers by default |
| **Limits** | Timeouts and process-group kill; `prlimit` for file size and open files. On the server, the container's own cgroup caps everything together | Timeouts and process-group kill; no per-process memory limit | Job object: memory, active processes, CPU rate, kill-on-close for the whole tree |
| **Setup needed** | Unprivileged user namespaces. Ubuntu 24.04+ restricts them by default, which a `.deb` install fixes by shipping an AppArmor profile for the bundled `bwrap`. An AppImage can't, and then commands are unavailable until the user installs the package or chooses the unsandboxed mode (§3.7). The server container needs a seccomp profile that allows user namespaces (§3.8) | None. Seatbelt is deprecated as a public API but is what Claude Code, Codex and sandbox-runtime use | None (no UAC prompt). Verified for each tool in the Windows spike (W0) |
| **Start time** | A few milliseconds per command (bubblewrap is a plain `exec`) | A few milliseconds | Profile creation once; tens of milliseconds per command |
| **File performance** | Native: bind mounts | Native | Native |
| **Status of the library** | sandbox-runtime: supported on Linux, beta research preview | Supported, beta | sandbox-runtime's Windows backend is alpha and needs one elevated install (sandbox user, WFP filter). Claude Code runs commands unsandboxed on native Windows today |

**Why AppContainer on Windows.** These are the Windows primitives that need no administrator:

- **Restricted tokens** (Codex's "unelevated" mode): limit writes, but reads stay the user's, and they give no network control.
- **Job objects**: give resource limits and tree kill, not isolation.
- **Firewall rules and WFP filters** (Codex "elevated", sandbox-runtime Windows): need an administrator.

AppContainer is the only one of these that confines both reads and network with no administrator. Its known cost is compatibility: tools that expect the user's profile, or MSYS2/Cygwin runtimes such as Git Bash, may fail inside it. So the Windows toolchain is native Win32 (§3.4), and spike W0 runs the toolchain's own test commands in the AppContainer before the design is fixed. **If W0 fails**, the fallback is sandbox-runtime's Windows backend, with one UAC prompt at setup ("Allow the assistant's sandbox to be set up? Windows asks once."), or Codex's approach if that is further along by then. Unsandboxed commands are never the silent fallback.

**What isn't used.** Docker, because it isn't available on desktops; the server still runs the app in Docker, but the sandbox doesn't depend on it. Bundled Linux VMs (WSL2, Lima, Virtualization.framework, Firecracker, krun) and gVisor, which the owner rejected.

### 3.3 The seam: `commandSandboxes` (registered, replaceable)

Like every feature, the sandbox is a registered part that a plugin can replace (memory: self-customizable harness). The registry lives on the server, in `sandbox/registry.ts`:

```ts
interface CommandSandbox {
  readonly id: string                                     // "linux-bwrap", "macos-seatbelt", "windows-appcontainer", "none"
  readonly label: string; readonly explanation: string    // user-facing: "Commands run in a sandbox: they see only your files and the internet."
  readonly platforms: ReadonlyArray<NodeJS.Platform>
  readonly available: Effect<Availability>                // ok | { reason, fix? } ("Install the .deb package…")
  readonly prepare: (account: AccountEnv) => Effect<void> // profiles, ACLs, home folder: idempotent
  readonly run: (spec: RunSpec) => Effect<RunHandle>      // argv, cwd, env, mounts, network ("public" | "none"), limits, signal
  readonly describe: Effect<SandboxFacts>                 // isolation, network control and limits, for Settings and the model
}
interface Toolchain {                                     // registry `toolchains`
  readonly id: string; readonly platform: NodeJS.Platform; readonly arch: string
  readonly artifacts: ReadonlyArray<{ name: string; url: string; sha256: string; bytes: number; licence: string; unpack: "zip" | "tar.xz" | "tar.gz" | "none" }>
  readonly path: ReadonlyArray<string>                    // what goes on PATH inside the sandbox
}
```

- **Selection**: the first available sandbox for the platform, unless the instance or desktop setting names one. A missing sandbox is shown, never skipped silently. Without one, commands aren't offered, and the capability row says why and how to fix it. The file tools still work.
- **`none`** is the unsandboxed sandbox (§3.7). It is registered like the others, so it's visible and replaceable, but the planner offers it only under §3.7's rules.
- The proxy (§3.5) is a separate registered part (`sandboxNetwork`), so a plugin can change the network policy without touching the sandbox.

### 3.4 The tools: shipped or fetched (owner [D]: "We can just ship whatever we need ourselves")

The agent never depends on what the machine has installed. Each platform's `Toolchain` lists pinned artifacts from their official release locations:

| Tool | Linux | macOS | Windows | Licence | Approx. download |
|---|---|---|---|---|---|
| Node 24 (with npm, npx) | Official Node binary tarball (same version as the app) | Official Node binary | Official Node zip | MIT; npm Artistic-2.0 | 25–30 MB |
| Python 3 | python-build-standalone `install_only` (relocatable CPython, pip included) | same | same | PSF and bundled component licences | 30–45 MB |
| uv | Official release | same | same | MIT / Apache-2.0 | 15–20 MB |
| Git | Server: Debian package. Desktop: GitHub Desktop's `dugite-native` portable Git | `dugite-native` | MinGit (Git for Windows' portable distribution) | GPL-2.0 (shipped as separate programs, with the source offer the licence needs) | 30–50 MB |
| Shell and core utilities | The system's `sh`/`bash` and coreutils, read-only (server image: Debian's) | The system's `zsh`/`bash` and BSD utilities | BusyBox-w32 (`sh` plus the common utilities, native Win32, about 1 MB) | GPL-2.0 | ~1 MB |
| ripgrep | Official release | same | same | MIT / Unlicense | 2–6 MB |
| bubblewrap, socat (sandbox-runtime needs them on Linux) | Server image: Debian packages. Desktop: shipped static builds | — | — | LGPL-2.0+ (bwrap), GPL-2.0 (socat) | <1 MB |

- **Server**: the Docker image installs all of these at build time (Debian packages, plus the official Python and uv builds). That adds about 250 MB unpacked to today's 577 MB image. No fetch happens at runtime.
- **Desktop**: the installer stays small. On the first command, or from Settings → Assistant tools, the app downloads the toolchain once, about 120–150 MB, with progress ("Setting up the assistant's tools: 64 of 140 MB"). It checks each artifact's SHA-256 from the app's own manifest and unpacks it into the app's data folder. A "full" installer with the toolchain inside is a packaging choice, available for offline installs. Updates come with app updates that change the manifest. Electron's own Node isn't reused, since it has no npm and its version follows Electron.
- **Inside the sandbox**, `PATH` puts the toolchain first, then the system's read-only directories. `pip install --user`, npm's global prefix and caches go to the persistent home folder (§3.6). The model's tool descriptions name the versions, and say that system package managers (`apt`, `brew`) aren't available.
- **Windows shell**: BusyBox `sh` is the `bash` tool's shell, and PowerShell is reachable as a program if W0 finds it works in the AppContainer. The tool description says which shell it is, so the model writes POSIX `sh`.

### 3.5 Network

- **On by default** (owner [D]). The sandbox reaches the **public internet only**. Linux and macOS go through the app's proxy (HTTP CONNECT and SOCKS5, run by sandbox-runtime's proxy machinery, or our own behind the same sockets). It allows every public host and refuses connections whose **resolved address** is loopback, private (RFC 1918, CGNAT, unique-local IPv6), link-local or a metadata address, so the sandbox can't reach the app itself, the LAN, local model servers or the reverse proxy. Whether sandbox-runtime accepts an allow-everything-public rule is verified in L0; if not, our proxy implements the rule. On Windows the AppContainer's `internetClient` capability without `privateNetworkClientServer` gives the same shape.
- **Limits that come with proxies**: HTTPS, HTTP and anything that honours proxy settings work, which covers `git clone https://…`, `npm`, `pip` and `curl`. Raw TCP, UDP and `ssh` (Git over SSH) don't, on Linux and macOS. The tool description says so.
- **Per workshop**: a capability row, **Internet from commands**, On by default. Off runs commands with network `"none"` (no proxy socket, or no capability on Windows).
- The proxy runs in the app process but off the main thread's hot path (a dedicated worker). It logs nothing about requests except per-account byte counts for the usage display.

### 3.6 Persistence, lifetime and separation

- **Nothing to start or keep.** A command is a sandboxed child process. What persists is the account's Files, its **home folder** (`DATA_DIR/env-home/<userId>` on the server; the app's data folder on desktop), mounted as `/home/user` or the platform's equivalent, and the toolchain. Work is picked up later because it is in those folders (owner [D]: work persists, no per-session setup).
- **Background commands** stay children of the app, killed after 2 hours or by `bash_stop`. They die with the app's process. **Reset** (Files panel ⋯) empties the home folder only; the files stay.
- **Separation between accounts** (server): each command's sandbox binds only that account's tree, plus folders shared with it, read-only for Can view. It binds that account's home, the toolchain read-only, `/app-source` read-only, and a private `/tmp`. It runs in its own PID namespace, so other accounts' processes are invisible. All accounts' commands run as the same OS user inside the server container. Separation is by what is mounted, which the app computes from the database and the safe walk, never from the model's paths. App-side, file tools and routes check ownership and shares through a reader-worker operation (`AuthorizeFilePath`).
- **Resource limits** (server, instance settings): a foreground command runs at most 10 minutes; at most 4 concurrent commands per account and 16 per instance, with a queue beyond. Memory and CPU are capped together by the server container's own limit (set it in compose). Per-account memory limits would need cgroup delegation, which the container doesn't have; that is Later.
- **`/app-source`**: at startup the app copies its shipped source for the running commit (`packages/*/src`, the plugin API, `spec/` and `ARCHITECTURE.md`, with `SOURCE.md` naming the commit) into `DATA_DIR/app-source/<commit>/`. Every sandbox binds it read-only. It's the same code the browser already downloads, with no data or configuration, and it's needed for plugin work, so every account gets it. The image would add `spec/` and `ARCHITECTURE.md` (about 2 MB).

### 3.7 Host folders and running without a sandbox (owner [D]: "Then it just becomes like Claude Code.")

**Who.** These options appear only where the person running commands already controls the machine:

| | Desktop app | Server, admin | Server, regular account |
|---|---|---|---|
| Choose a folder outside Files | Yes | Only folders under roots the operator lists in `HOST_FOLDERS` (an environment variable, set outside the app like every security setting; in Docker these are paths the operator mounted into the container) | Never |
| Run commands without a sandbox | Yes, per workshop, after consent | Only with `ALLOW_UNSANDBOXED_COMMANDS=1` set outside the app, then per workshop, after consent | Never |

- **Choosing a host folder**: the working-folder popover gets a row, **Folder on this computer…** on desktop, which opens the system's folder dialog, or **Folder on the server…** for an admin, a folder browser limited to `HOST_FOLDERS` (the import page's folder browser, reused). The chip shows a folder icon with a computer badge, and its tooltip says "A folder on this computer, outside your files".
- **With the sandbox still on** (the default): the sandbox binds that folder read-write in place of, or alongside, Files. Everything else stays: network rules, no app data, no other accounts. This is how Claude Code works with sandboxing: the project folder is writable, and the rest is not.
- **Without a sandbox**: a per-workshop row in the capability chip, **Run commands without a sandbox**, Off by default, which only the owner can turn on, through a dialog:
  - Desktop: "**Run commands without a sandbox?** Commands will run as you on this computer. They can read and change any file you can, including this app's saved keys and chats, and use your network and other devices. Changes outside your files can't be undone or restored." Buttons: **Run without a sandbox** · **Keep the sandbox**.
  - Server admin: the same, with "They run as the server's app and can read and change every account's chats, files and keys."
  
  When on, the `none` sandbox runs commands directly as the app's user, with timeouts and output limits only. The chip and every command step carry a warning-tone "No sandbox" mark. Commands follow the `commands` capability as usual (Allowed by default): the consent is the one infrequent, important prompt (PLUGINS §1 [D]), not a prompt per command.
- **What host folders change elsewhere**: no quota; app-side writes are still versioned; the after-command scan covers only the working folder (§7.2); deleting from the app moves the item to the app's bin. Shares never include host folders. A card's remembered folder (§2.3) can be a host folder, but only on the same desktop or for the same admin.
- **What never reaches regular server accounts**: host folders, the `none` sandbox, `HOST_FOLDERS` and the unsandboxed switch. Their rows aren't offered, and the server refuses them in `AuthorizeFilePath` and in sandbox selection, whatever a request says.
- **Later**: opening a folder in the system's own file manager from the desktop app (owner [D], §11).

### 3.8 The server deployment (checked 2026-11-17)

- **Today**: one container, from `node:24.22.1-trixie-slim`, running as `node` (uid 1000) with `./data:/data`, behind the reverse proxy. There is no Docker socket and no extra capability. The production Docker host runs Docker 29.2.1, rootful, cgroup v2, AppArmor and seccomp. (This was a read-only lookup over SSH, made without asking first, which the house rule for that host requires.)
- **Changes**: the image adds the toolchain and `bubblewrap`/`socat` (§3.4). Compose adds a **seccomp profile** that permits creating user namespaces: Docker's default profile with `unshare`/`clone` of a new user namespace allowed, shipped in the repo as `docker/seccomp-userns.json`. It also adds an **AppArmor** setting that lets `bwrap` mount inside its own namespace, either a shipped profile or `apparmor=unconfined` on this one service, decided in L0 by what actually works on the host. No socket, sidecar or new service. The files can stay in `./data`.
- **Why this is acceptable**: the container is still the outer boundary around the app. Inside it, the sandbox keeps commands away from `/data` (the database, the server secret and every account's data) and from each other. Allowing user namespaces inside the container slightly enlarges the kernel surface a command can reach, so L0 checks the result with the same escape tests as desktop Linux (§9). sandbox-runtime's "weaker nested sandbox" mode is not used.
- **Native and dev runs** (the README's laptop runs, a development server) use the same `linux-bwrap` sandbox with the host's user namespaces.

## 4. Consent: what reaches a provider

- **The rule is unchanged** (DESIGN §11 [D]: nothing goes to a provider the user didn't choose). File contents reach a model in two ways only. Either the user attaches a file and submits, or the agent reads it during a run the user submitted. Either way it goes to that workshop's chosen model, like every other tool result. The app doesn't index, embed, caption or preview files with any provider. Token counts for attachments follow the connection's existing Token counts choice, as image counts do (ARCHITECTURE §6).
- **The sandbox's network is not a provider send.** The app sends nothing through it. The sandbox holds no keys: connection keys, MCP credentials and the server secret stay in the app's data, which the sandbox can't see and whose server it can't reach (§3.5, §3.6). The unsandboxed mode is the exception, and its consent says so (§3.7). If the agent calls a provider's API from a command, it has no key unless the user put one in their own files, and that is the user's own doing (DESIGN §7.7 [D]: content the user loads is their own prompt).
- **What limits apply**: private destinations dropped, DNS pinned, no inbound, per-workshop **Internet from commands** Off, every command shown in Steps before its output, and resource limits. Data can still leave through the network, just as it can from a coding agent with internet access. The owner asked for network by default ([D]), so this is accepted and shown, not hidden: the capability chip counts it, and its row explains "Commands can use the internet. They can't reach this server, your other devices or other accounts."
- **The app-side `network` capability** (the workshop's web fetch, Ask first today) is proposed to become **Allowed** by default, to match "network is available by default". This is [P]. MCP keeps its own rules (DESIGN §7.8 [D]).

## 5. Agent tools

### 5.1 Commands (in the sandbox)

| Tool | Arguments | Result | Class |
|---|---|---|---|
| `bash` | `command`; `description?` (shown in Steps); `timeout_ms?` (default 120,000, at most 600,000); `cwd?` (default: the run's current directory); `run_in_background?` | `exit: N`, the directory after the call, then combined output up to 30,000 characters (a head and a tail with "… 1,204 lines left out …"). The full output, up to 16 MiB, is kept by the app, and the result names its id for `bash_output` | `outside` |
| `bash_output` | `id`, `offset?` (line), `limit?` (default 400 lines) | A page of a command's full output, or what a background job wrote since the last read, with its state | `read` |
| `bash_stop` | `id` | Stops a background job (TERM, then KILL after 5 s) | `outside` |

- Each call runs `<shell> -c 'cd <dir> && <command>; echo <sentinel> "$PWD"'` through the selected `commandSandboxes` entry (§3.3), as a new process group (Linux, macOS) or in a new job object (Windows). Timeout, Stop and Resume kill the whole group or job: TERM, then KILL after 5 s. reference-harness's marker kill isn't needed, because the process is the app's own child. Calls in one workshop run one at a time (`executionMode: "sequential"`), while different workshops of the same account can run at once.
- **Approval**: under the `commands` capability, **Allowed** by default (owner [D]: tools are available without setup). Off and Ask first work as for every capability. An interrupted command without a receipt is never re-run silently. It asks, as built for other `outside` calls ("The app stopped while this was running. It may already have happened: check before allowing it again.").
- **Steps** shows the command, its directory, exit code, duration, the folded output, "Changed 3 files" (§7.2), and **Stop** while it runs.

### 5.2 Files (in the app)

| Tool | Arguments | Notes | Class |
|---|---|---|---|
| `read_file` | `path`, `offset?`, `limit?` (lines, default 2,000) | Text with line numbers. An image goes as an image block to a vision model, otherwise its type and size are described. A PDF gives its text, extracted in the app by pdf.js in a worker (the same pinned `pdfjs-dist` as the viewer), with page numbers. Other binary files are described | `read` |
| `write_file` | `path`, `content` | Creates or replaces. Replacing an existing file requires that it was read in this run and hasn't changed since (hash check) | `files` |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?`, or `edits[]` | reference-harness's `str_replace_based_edit_tool` semantics: exactly one match unless `replace_all`, all-or-nothing batches, a CRLF hint. Same read-first rule | `files` |
| `list_files` | `path?`, `glob?`, `depth?` | Names, kinds, sizes and times, at most 500 entries | `read` |
| `search_files` | `pattern`, `path?`, `glob?`, `case?`, `context?` | ripgrep in the sandbox. Without one, a bounded in-app literal search (at most 30 matches). At most 15,000 characters | `read` |

- Paths are the sandbox's own (`/files/...`, `~`; host folders by their real path, §3.7), so a path from `bash` output works in the file tools and the other way round. The file tools reach `/files` and `/app-source`, and host folders the workshop may use, but not the home folder or system paths. For those, the result says to use `bash`.
- Every `write_file` and `edit_file` call stores the earlier content as a version and writes `rollout_effects` rows of kind `file.write` or `file.edit`, with the version id as the Undo recipe (§7.1).
- **Capabilities**: a new capability `files`, "Change your files", Allowed by default. Reading is part of it and can't be turned off on its own, since the assistant is useless in a folder it can't read. `commands`, "Run commands", Allowed by default. The **Internet from commands** row (§3.4). All three are stored in the existing `workshop_grants` table.

### 5.3 Plugins in the sandbox

- `plugin_create` also makes a working copy at `Files/Plugins/<id>/` (the files, plus a `.git` for the agent's own use). The agent edits it with the ordinary file tools or commands, and runs the plugin's tests with `npm test` or `node --test` as it likes.
- **`plugin_commit`** gains `from: "files"`. It reads the working copy's files (never its `.git`) through the same bounded repository child and the same `authorRepo.ts` checks, which are paths, sizes, link refusal and text-only, and commits that tree to the app's repository, the authority. Receipts and Undo stay as built. After a commit, rollback or Undo, the app writes the repository's tree back into the working copy and tells the agent if it overwrote uncommitted changes there. Those are kept as versions.
- **Unchanged**: `plugin_check` runs the restricted checker in the app on the committed tree; `plugin_enable` always asks, with exact-version consent; regular accounts may only commit browser plugins (ARCHITECTURE §17). Nothing the environment does can enable code. The app never reads a `.git` the environment wrote, so a planted repository can't reach the authority repository's journals or builds.
- `plugin_read`, `plugin_write`, `plugin_edit` and `plugin_search` remain for places where commands aren't available.

### 5.4 Per-chat switches (from Open WebUI's shell feature)

The owner pointed to Open WebUI's shell feature only, and to nothing else of its agentic design ([D]). What is taken from its public docs ([file browser](https://docs.openwebui.com/features/open-terminal/file-browser.md), [connecting](https://docs.openwebui.com/features/open-terminal/setup/connecting.md)):

| Open WebUI | Here |
|---|---|
| A terminal is selected per conversation from a button in the chat input; its name shows beside the button | The workshop's capability chip (built) gains the **Change your files**, **Run commands** and **Internet from commands** rows. The working-folder chip (§2.2) shows where commands start |
| Admins turn a terminal on or off for the instance and for groups | Settings → Assistant tools (admin): commands on or off for the instance and per account, which sandbox is used and why (§3.3) |
| A **Files** tab in the right side panel: breadcrumb path, folders first, sort, list or grid, upload by drag (folders keep their structure), new file and folder, rename, delete, download | The workshop's **Files** side-panel tab (§8.1): the same operations, plus bin and Undo, and **Set as working folder** |
| Previews per type: code editor, PDF, Markdown with source toggle, CSV tables, images, sandboxed HTML | The viewers (§8.2) |
| Drag a file onto the message input to attach it | The same, without copying (§6.1) |
| Refreshes when the AI changes files | Live refresh from file-change notices (§8.1) |
| Read-only folders and files are marked, with actions disabled | Can view shares are marked, with actions disabled |

Not taken: its terminal pane and the AI's terminal tabs. Commands show in Steps instead, and a user terminal is Later.

## 6. Attachments

### 6.1 In workshops (any type)

- The composer's Attach button (built, images only today) accepts **any file** in a workshop, as do paste and drop. Each attached file is uploaded into **`<working folder>/Attachments/`** under its own name, with " (2)" for a name already taken. That is a real file in Files, visible to the agent's tools and commands at that path (owner [D]: "it would have to be able to see these as files too").
- Dragging a file from the Files panel onto the composer attaches **that file**, with no copy. Several can be attached at once.
- **The message keeps a copy as sent.** At send, each attachment's current content is recorded in `media_assets`, as images are now (`version_attachments`, with the new `name` and `path` columns, §10). So a later edit or deletion of the file never rewrites what the message showed or what a regenerated reply saw (causal order). The message's attachment opens the copy as sent. **Open in Files** opens the current file, if it still exists, and says when it has changed since.
- **What the model receives, as a delta from reference-harness** (owner [D]: "the agent needs to see what folder they're in, and have automatic access to them. reference-harness does have that too."). reference-harness's enrichment downloads every attachment into the agent's workspace (`<agentRoot>/msg-attach/<provider>.<account>/<filename>`) with no tool call. It renders each one in the message as `<attachment filename="…" type="…" size="…" path="…"/>`, adding `image_block="true"` on the image sent as a multimodal block and a `[caption: …]` for images a non-vision model can't see. Here:
  - **Taken**: the file is in place before the model sees the message, so access is automatic. The same `<attachment>` element goes in the user message, with `path` the full sandbox path (`/files/thesis/Attachments/report.pdf`), and with `image_block="true"` on images sent as blocks through the built image pipeline (vision check, last-N limit, exclusion toggles).
  - **Changed**: the folder is `Attachments/` in the working folder instead of a per-platform `msg-attach/` tree, because the user organizes these files. No captions: a caption would send the image to a model the user didn't choose for this (DESIGN §11 [D]), so a non-vision model gets the path and a note that it can't see images.
  - **Not taken**: `linked_media` and `preview_media`. Links in a message aren't fetched on their own.
  - Other files are read by the agent with its tools when it needs them, so a large PDF doesn't fill the context unasked. The element lists the same path in later turns, so the file can be found again after summaries.
- **Native viewers on attach**: thumbnails in the composer for images, and a type icon with the name for other files. Clicking either opens the viewer (§8.2) in the existing peek modal, as composer images open today. Until the viewers land (track B), non-image files offer Download.
- The attachment draft (`composer_images`, with the new `kind` and `name` columns) keeps its built rules: persisted before upload, recovery across reloads and devices, consumed exactly once by the send.

### 6.2 In story chats

- Unchanged: images only, sent as image blocks, stored as message media (ARCHITECTURE §12). The design allows any type there too: the same upload, a copy as sent, and text files sent as text. That is question 1.

## 7. Changes and Undo for file edits and commands

### 7.1 File tools: Undo

- `file.write`, `file.edit`, `file.create` and `file.delete` effects show on the step and in the Changes panel (both built), each with **Undo** ("Puts the file back as it was before this change") and **Open**. Undo restores the recorded version, after checking that the file is still as the agent left it. Otherwise it is refused with "Changed since. Open its versions." "Undo all of this reply" (built) works newest first and stops at a refusal, as built.

### 7.2 Commands: listed, restorable, not undoable

- **What is found.** After each command, the app scans the account's tree for what changed. It compares size, mtime, ctime and inode against the index left by the previous scan. It skips `node_modules`, `.git`, `.venv`, `__pycache__`, `target`, `dist`, `build` and `.cache` (listed in Settings → Assistant tools). The scan has a 2-second budget: past it, the row says "Many files changed; not all are listed". For each changed or new file of at most 16 MiB, up to 256 MiB per command, the new content is stored as a version (origin `command`). Together with the versions from app-side writes, that means the app usually holds the content each file had before the command.
- **How it shows.** One `shell.run` effect per command: "Ran `npm install` in /files/site: 2 files changed, 1 deleted, 14 created", with the list folded under it. There is no Undo button. The row offers **Restore** for each file it has an earlier version of, and **Restore all it can**. Each restore is a new version with its own Undo. The row says plainly what it can't restore ("Can't be restored: changes in node_modules, in your home folder, outside your files, and anything sent over the internet."). Regenerating a reply that ran commands warns as built: "This reply ran 3 commands. A new version won't undo them."
- The difference is deliberate. Undo means the change is reversed in full. Restore means a file comes back as the app last saw it, and the command's other effects stay.

## 8. The file-manager UI (parallel track B)

### 8.1 The Files panel and page

- **A workshop side-panel tab, Files**: a `chatPanels` entry, order 90, before Changes (92). It opens at the branch's working folder. Like every side-panel editor, it has full parity on its own and is the phone UI (memory: sidebar editors standalone):
  - a breadcrumb path with Copy path;
  - folders first, sorted by name, size or date;
  - per-row ⋯ buttons, and app context menus on rows (the browser's menu stays on text);
  - Upload (button and drop, files or folders), New folder, New file, Rename, Move to…, Delete (bin, with Undo), Download (folders as zip);
  - **Set as working folder**, which writes `workshop.folder`, the same as the chip;
  - a "Working here" mark on the current folder;
  - Can view shares marked, with their actions disabled.
  
  Every action has a hover explanation (memory: explain on hover).
- **A Files page**, `/files/<path>`, in the main navigation, with the same component full width: a tree on the left at wide widths, and the panel's layout on a phone. Each opened file is a workbench tab whose URL is `/files/<path>?view=…` (memory: URL is truth).
- **Live refresh**: the app publishes `FilesChanged { userId, paths }` on the existing per-account notice channel after app-side writes and after each command's scan. Open panels refresh those folders.
- **Mobile**: one column; long press opens the row menu as well as its ⋯ button; drag-to-move becomes Move to…; uploads use the system picker. The layout audit covers 1440 and 390 in both themes.

### 8.2 Viewers

| Type | Viewer |
|---|---|
| Text and code | CodeMirror 6 (already a dependency), with language modes loaded lazily (exact-pinned `@codemirror/lang-*` packages). Edits use the existing drafts machinery (`drafts.target_kind = "file"`, a registry entry, with the base content's hash in `base_revision`), so an unsaved edit survives reloads and devices. Save checks the hash. If the file changed on disk, the conflict offers Compare (the built `@codemirror/merge` view), Load the latest, or Save as a copy. Files over 5 MiB open read-only, a page at a time |
| Markdown | Rendered with the message renderer (sanitized), with an Edit/Preview toggle |
| CSV, TSV | A table, with Edit as text |
| Images | The built image viewer and picture tabs |
| Video, audio | Native `<video>` and `<audio>` elements, with Range requests |
| PDF | pdf.js (`pdfjs-dist`, exact-pinned, loaded lazily, its worker same-origin, PDF scripts never run), pages with thumbnails on wide screens |
| HTML | Source, with an opt-in preview in the existing sandboxed message-HTML frame (HTML-MESSAGES), never on the app's origin |
| Anything else | Name, type, size, Download |

## 9. Build plan

The owner [D]: a file-management UI "can't slow down or block it or anything else". Track A has no dependency on track B. Track A needs no new UI beyond the folder chip and its list popover, the capability rows, the effect rows, and the Attach button accepting any type.

**Track A: sandbox, folders, tools**

| Unit | What | Depends on |
|---|---|---|
| **A0** | Migration `0002_files` (§10); registry kinds; `FILES_DIR` and quota accounting; `safePath.ts` no-follow walk with its tests (links, FIFOs, renamed parents, races); `ListFiles`, `AuthorizeFilePath`, `file_versions` writer and reader operations | — |
| **A1** | App-side file tools (§5.2), with versions, effects and Undo; `files` capability; `workshop.folder` state key, the folder chip and popover (§2.2), card memory (§2.3); upload and raw HTTP routes | A0 |
| **L0** | Linux spike, measured on the dev host and inside the server image: sandbox-runtime wrapping bubblewrap with user namespaces, the allow-all-public proxy rule, private-address refusal, the seccomp/AppArmor settings for the server container, and escape tests (reading `/data`, another account's files, `/proc` of other processes, the LAN, loopback, links planted for the app) | — |
| **A2** | `commandSandboxes` and `toolchains` registries; `linux-bwrap`; the Linux toolchain in the server image; `bash` with timeouts, tree kill and paged output; `search_files`; the after-command scan and `shell.run` rows with Restore (§7.2); `commands` and Internet capabilities; Settings → Assistant tools (admin); compose's seccomp profile | L0, A0 (A1 for Restore) |
| **A3** | Attachments of any type in workshops (§6.1): uploads into `Attachments/`, `version_attachments.name` and `path`, the model's attachment lines, image blocks | A1 |
| **A4** | `/app-source` copy and mount; `Plugins/<id>` working copies and `plugin_commit from: "files"` (§5.3) | A2 |
| **A5** | Background jobs (`run_in_background`, `bash_output`, `bash_stop`), Reset (home folder), usage display; shares in the sandbox's binds | A2, B3 for the share UI |
| **A6** | Host folders and the `none` sandbox for server admins (§3.7): `HOST_FOLDERS`, `ALLOW_UNSANDBOXED_COMMANDS`, the picker rows, the consent dialog, the "No sandbox" marks | A2 |

**Track D: desktop platforms (with the desktop package, after A2)**

| Unit | What | Depends on |
|---|---|---|
| **M1** | `macos-seatbelt` through sandbox-runtime; the macOS toolchain manifest and first-run fetch | A2, a desktop build |
| **W0** | Windows spike: AppContainer plus job object through `rp-sandbox-win.exe`; Node, Python, uv, MinGit's `git`, BusyBox `sh` and ripgrep running inside; `internetClient` without LAN; ACEs on the Files, home and toolchain folders; no administrator anywhere. Its result picks AppContainer or the one-prompt fallback (§3.2) | A desktop build |
| **W1** | `windows-appcontainer` (or the fallback) and the Windows toolchain | W0 |
| **D1** | Desktop host folders and unsandboxed mode (§3.7), the system folder dialog, the Linux `.deb` AppArmor profile | M1 or W1 |

**Track B: file manager (parallel, from A0's operations)**

| Unit | What | Depends on |
|---|---|---|
| **B1** | Files panel and Files page (§8.1), upload of files and folders, rename, move, delete with bin and Undo, download, live refresh | A0 (and A1's upload route) |
| **B2** | Viewers (§8.2), drafts and conflicts for the editor; attachments open in them | B1 |
| **B3** | Sharing UI and `file_shares` operations; the Versions dialog | B1 |

Each unit gets its own review. **Linux comes first** because the server and a development server run it now; it is also the desktop Linux sandbox. macOS reuses the same library. Windows has the most unknowns, so its spike runs as soon as a desktop build exists, in parallel with everything else. Track A's file tools, attachments and folder chip don't depend on any sandbox.

## 10. Database and baseline impact

**`baseline.ts` is unchanged.** The schema is frozen, so all changes go in one additive migration, `0002_files`, that never rewrites existing rows:

- **`file_versions`** (new): `id`, `owner_user_id` (users, cascade), `path` (≤ 4,096), `inode`, `media_id` (media_assets; null for a recorded deletion), `byte_size`, `origin` (registry `file_versions.origin`: `upload`, `editor`, `agent`, `command`, `restore`, `delete`), `actor_user_id`, `rollout_id`, `tool_call_id`, `created_at`. Indexes on `(owner_user_id, path, created_at)` and `(rollout_id, tool_call_id)`. A trigger makes the rows immutable except for deletion by retention. Foreign keys are indexed on the referencing side, as `schema.test.ts` requires.
- **`file_shares`** (new): `id`, `owner_user_id`, `path`, `inode`, `grantee_user_id`, `mode` (`view` or `edit`), `created_at`, unique `(owner_user_id, path, grantee_user_id)`, a trigger refusing a share with oneself, and indexes on both users.
- **`version_attachments`**: `ADD COLUMN name TEXT` and `ADD COLUMN path TEXT`, both nullable, so existing image rows stay valid.
- **`composer_images`**: `ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'` and `ADD COLUMN name TEXT`. The table keeps its name, since renaming it would be a rewriting migration.
- **No migration needed** for: bin kind `file`; effect kinds `file.*` and `shell.run` (the `rollout_effects_owner` trigger already admits other target kinds); `drafts.target_kind = "file"`; `version_attachments.kind = "file"`. These are `storageKinds` registries, with no `CHECK` lists. Also no migration for the settings `workshop.cardFolders`, `workshop.lastFolder`, quotas and environment settings (the `settings` table), the grants (`workshop_grants`), or the state key `workshop.folder`. Sandbox state (profiles, ACLs, the toolchain) lives on disk and in the platform, not in the database.
- **Tests**: `preSquashSchema.json` is regenerated from baseline plus migrations. A new test opens a database made at `0001_baseline` with synthetic rows, runs `0002_files`, and checks that the rows and the schema match. It is the first real upgrade the migrator runs, so this test is required. the release gate keeps working in keep mode, since `baseline.ts` doesn't change.

## 11. Later

- **Opening the folder on the user's own computer** (owner [D]: "a user should also be able to open the folder on their system if the harness is running on their PC, but that would be an exception, not the rule (and something we can work out later when we have a desktop packaged version of the app)"). With a desktop package, the files directory would be a normal local folder the system's file manager can open.
- A terminal for the user in the Files panel, in the same sandbox as the agent's commands.
- Inline file cards in replies ("present_file"), opening at a page.
- Hard quotas (ZFS datasets or XFS project quotas); per-account memory and CPU limits on the server (cgroup delegation); bandwidth limits.
- Allowing chosen LAN addresses (local model servers) per instance.
- Instance-wide shared folders; sharing a single file.
- Commands in story chats with tools, if the owner wants them (question 1).
- A domain allow list per workshop, if the owner wants one later (the proxy already supports it).

## 12. Questions for the owner

1. **Story chats.** In workshops, any file can be attached and becomes a file the assistant can open. Story chats today accept only images. Should story chats also accept any file type, with text files sent to the model as text and other files kept as attachments you can open? Or should they stay images only?

These were decided as recommendations, not asked:
- Windows uses AppContainer with no administrator. If the spike shows tools break there, Windows asks once for administrator rights at setup, as Codex does.
- The tools are fetched on first setup, with a full offline installer as an option.
- Unsandboxed commands are Allowed after their one consent, not asked per command.
- No folder confinement.

## 13. Sources (checked 2026-11-17)

- Anthropic sandbox-runtime, README: platforms, mechanisms, proxies, the Ubuntu 24.04 user-namespace restriction, the Docker nested mode and the Windows alpha backend: https://github.com/anthropic-experimental/sandbox-runtime
- Claude Code sandboxing: macOS, Linux and WSL2; native Windows runs unsandboxed: https://code.claude.com/docs/en/sandboxing
- Codex Windows sandbox: restricted tokens, sandbox users, firewall rules; elevated and unelevated modes: https://developers.openai.com/codex/windows and https://www.infoq.com/news/2026/06/codex-windows-sandbox-design/
- Open WebUI Open Terminal, file browser and connection docs: https://docs.openwebui.com/features/open-terminal/file-browser.md and https://docs.openwebui.com/features/open-terminal/setup/connecting.md
- reference-harness `latest` (9b385944): ARCHITECTURE §7a (attachment enrichment, `<attachment>` rendering), §11a (sandbox), §11c (compose); `src/sandbox/manager.ts`.
- Still to verify in the spikes, not from documentation: sandbox-runtime accepting an allow-all-public rule (L0); the exact seccomp and AppArmor settings that let `bwrap` run in the server container (L0); each Windows tool running inside an AppContainer (W0); the toolchain sizes in §3.4, which are approximate and get pinned in the manifests.
