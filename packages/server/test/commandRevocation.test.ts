// The workshop's commands against the real sandbox, with storage stubbed (files4a review fixes):
// - a command changing a folder shared to edit charges and measures the owner's quota, keeps the
//   owner's versions with the acting account, and tells the owner's file managers; over the
//   owner's quota the folder is read-only;
// - taking away what a running command was given stops it at once: Run commands turned off,
//   the account disabled, a share stopped, the sandbox's grant or its consent withdrawn, the
//   admin role gone;
// - background slots are taken before any wait, so calls starting together keep to the limit;
// - the file tools see a shared folder only while it's the folder that was shared;
// - ended background commands are forgotten with their output;
// - a `Shared` in Files that isn't a folder is refused with a plain message;
// - shares of the server plugins' working copies never resolve;
// - Reset and commands exclude each other;
// - a subagent in its own copy reads the workshop's shared folders but writes only in its copy;
// - the app's commands for subagents' copies are running commands: Reset waits for them, and
//   revocation and the app's stop end them.
// Synthetic data only.
import { mkdir, readFile, rename, symlink, writeFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import type { CapabilityMode } from "@dreamspan/shared/workshopApi.ts"
import { makeFileTools } from "../src/agent/tools/files.ts"
import {
  capabilityDefaults,
  COMMANDS_UNSANDBOXED,
  consentTarget,
  workshopCapabilities
} from "../src/agent/capabilities.ts"
import { QuotaExceeded, type FilesQuota } from "../src/files/quota.ts"
import { makeCommandOutputs } from "../src/files/commandOutput.ts"
import { linuxBwrap } from "../src/sandbox/linuxBwrap.ts"
import { noSandbox } from "../src/sandbox/none.ts"
import type { RolloutTool, ToolContext, ToolOutput } from "../src/agent/tools.ts"
import type { CommandSandbox, RunResult } from "../src/sandbox/registry.ts"
import { tempDir } from "./support/tempDir.ts"

const commands = (await linuxBwrap.available()).ok
const registries = { workshopCapabilities, capabilityDefaults }
const consent = consentTarget(registries, COMMANDS_UNSANDBOXED)!

interface Share {
  id: string
  grantee: string
  ownerId: string
  ownerHandle: string
  path: string
  inode: number | null
  device: number | null
  suspendedAt: number | null
  createdAt: number
  mode: "view" | "edit"
}

/**
 * A sandbox whose commands run until they're stopped, so a test can act while one runs; `started`
 * resolves at each start.
 */
const heldSandbox = () => {
  let started: () => void = () => undefined
  const next = () => new Promise<void>((resolve) => (started = resolve))
  let waiting = next()
  const sandbox = {
    ...linuxBwrap,
    id: "held",
    available: async () => ({ ok: true as const }),
    run: (_spec: unknown, signal: AbortSignal) =>
      new Promise<RunResult>((resolve) => {
        const end = () =>
          resolve({
            exitCode: null,
            timedOut: false,
            outputCapped: false,
            head: "",
            tail: "",
            outputBytes: 0,
            cwd: null,
            durationMs: 1
          })
        signal.addEventListener("abort", end, { once: true })
        if (signal.aborted) end()
        started()
      })
  } as CommandSandbox
  return {
    sandbox,
    /** Resolves once a command started since the last call. */
    started: async () => {
      await waiting
      waiting = next()
    }
  }
}

const world = (
  options: { backgroundPerAccount?: number; allowUnsandboxed?: boolean; sandbox?: CommandSandbox } = {}
) => {
  const dataDir = tempDir("cmdfix")
  const filesDir = join(dataDir, "files")
  const homesDir = join(dataDir, "env-home")
  const state = {
    role: new Map<string, "admin" | "user">([
      ["ben", "user"],
      ["mara", "user"],
      ["ada", "admin"]
    ]),
    disabled: new Set<string>(),
    grants: new Map<string, CapabilityMode>(),
    consented: false,
    shares: [] as Array<Share>,
    overQuota: new Set<string>()
  }
  const versions: Array<{ userId: string; actorUserId?: string; paths: Array<string>; rolloutId?: string }> = []
  const changed: Array<{ userId: string; paths: ReadonlyArray<string> }> = []
  const quotaCalls: Array<string> = []
  const user = (id: string) => ({ id, handle: id, displayName: id, role: state.role.get(id) ?? "user" })
  const reader = {
    AuthorizePluginTool: ({ userId }: { userId: string }) =>
      state.disabled.has(userId)
        ? Effect.fail({ _tag: "ApprovalRefused", message: "off" })
        : Effect.succeed(user(userId)),
    WorkshopGrants: ({ target }: { target?: string }) =>
      Effect.succeed(
        target === consent
          ? state.consented
            ? [{ capability: COMMANDS_UNSANDBOXED, mode: "allow" as const }]
            : []
          : target
            ? []
            : [...state.grants].map(([capability, mode]) => ({ capability, mode }))
      ),
    StateEventsAt: () => Effect.succeed([]),
    WorkshopFolderMemory: () => Effect.succeed({ moves: [] }),
    FileSharesGrantedTo: ({ userId }: { userId: string }) =>
      Effect.succeed(
        state.shares
          .filter((s) => s.grantee === userId && !state.disabled.has(s.ownerId))
          .map(({ id, ownerId, ownerHandle, path, inode, device, suspendedAt, createdAt, mode }) => ({
            id,
            ownerId,
            ownerHandle,
            path,
            inode,
            device,
            suspendedAt,
            createdAt,
            mode
          }))
      ),
    GetPasswordHash: ({ userId }: { userId: string }) =>
      Effect.succeed(state.disabled.has(userId) ? null : { user: user(userId), passwordHash: null })
  }
  const writer = {
    RecordFileVersions: (input: {
      userId: string
      actorUserId?: string
      versions: ReadonlyArray<{ path: string; rolloutId?: string }>
    }) => {
      versions.push({
        userId: input.userId,
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
        paths: input.versions.map((v) => v.path),
        ...(input.versions[0]?.rolloutId ? { rolloutId: input.versions[0].rolloutId } : {})
      })
      return Effect.succeed(input.versions.map((_, i) => `v${versions.length}-${i}`))
    }
  }
  const quota = {
    check: (userId: string) => {
      quotaCalls.push(`check ${userId}`)
      return state.overQuota.has(userId) ? Effect.fail(new QuotaExceeded("over")) : Effect.succeed({})
    },
    afterCommand: (userId: string) => {
      quotaCalls.push(`after ${userId}`)
      return Effect.succeed(state.overQuota.has(userId) ? "over" : null)
    },
    wrote: () => undefined
  } as unknown as FilesQuota
  const sandboxes = [...(options.sandbox ? [options.sandbox] : []), linuxBwrap, noSandbox]
  const files = makeFileTools({
    dataDir,
    filesDir,
    homesDir,
    reader: reader as never,
    writer: writer as never,
    registries,
    sandboxes: { list: () => sandboxes, get: (id) => sandboxes.find((s) => s.id === id) },
    quota,
    holding: (_hashes, effect) => effect,
    outputs: makeCommandOutputs(dataDir),
    allowUnsandboxed: options.allowUnsandboxed ?? false,
    onChanged: (userId, paths) => changed.push({ userId, paths }),
    limits: {
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 60_000,
      perAccount: 4,
      perInstance: 16,
      backgroundPerAccount: options.backgroundPerAccount ?? 4,
      backgroundPerInstance: 16,
      backgroundMs: 600_000,
      run: { processes: 256, memoryBytes: 2 ** 30, fileBytes: 2 ** 30, openFiles: 1024, tmpBytes: 2 ** 26 }
    }
  })
  const tool = (id: string) => files.tools.find((t) => t.id === id)! as unknown as RolloutTool<Record<string, unknown>>
  let calls = 0
  const context = (userId: string, workspace?: { start: string; root?: string }) =>
    ({
      userId,
      chatId: `chat-${userId}`,
      forkId: null,
      slotId: "slot",
      versionId: "version",
      rolloutId: `run-${userId}`,
      toolCallId: `call-${++calls}`,
      leafSlotId: null,
      viewers: null,
      reader,
      writer,
      cache: new Map<string, unknown>(),
      ...(workspace ? { workspace } : {})
    }) as unknown as ToolContext
  const run = (
    userId: string,
    id: string,
    args: Record<string, unknown>,
    cache = new Map<string, unknown>(),
    workspace?: { start: string; root?: string }
  ) =>
    tool(id).execute(
      {
        ...(workspace ? { workspace } : {}),
        userId,
        chatId: `chat-${userId}`,
        forkId: null,
        slotId: "slot",
        versionId: "version",
        rolloutId: `run-${userId}`,
        toolCallId: `call-${++calls}`,
        leafSlotId: null,
        viewers: null,
        reader,
        writer,
        cache
      } as unknown as ToolContext,
      args
    ) as Effect.Effect<ToolOutput>
  const root = (userId: string) => join(filesDir, userId)
  /** Mara's folder `notes`, shared with Ben. */
  const share = async (mode: "view" | "edit", path = "notes") => {
    await mkdir(join(root("mara"), path), { recursive: true })
    await writeFile(join(root("mara"), path, "a.txt"), "first\n")
    const entry: Share = {
      id: `share-${state.shares.length + 1}`,
      grantee: "ben",
      ownerId: "mara",
      ownerHandle: "mara",
      path: `/files/${path}`,
      inode: (await stat(join(root("mara"), path))).ino,
      device: (await stat(join(root("mara"), path))).dev,
      suspendedAt: null,
      createdAt: Date.now(),
      mode
    }
    state.shares.push(entry)
    return entry
  }
  const idOf = (text: string) => /cmd_[a-f0-9]{16}/.exec(text)![0]
  const ended = (userId: string, id: string) =>
    Effect.gen(function* () {
      for (let i = 0; i < 100; i++) {
        const out = yield* run(userId, "bash_output", { id })
        if (out.text.includes(": ended")) return out.text
        yield* Effect.sleep("100 millis")
      }
      return "still running"
    })
  return { files, state, versions, changed, quotaCalls, run, context, root, share, idOf, ended, dataDir }
}

it.live.skipIf(!commands)(
  "a command through a folder shared to edit is the owner's: quota, versions with the actor, file managers",
  () =>
    Effect.gen(function* () {
      const w = world()
      yield* Effect.promise(() => w.share("edit"))
      const out = yield* w.run("ben", "bash", {
        command: "echo new > /files/Shared/mara/notes/new.txt; echo more >> /files/Shared/mara/notes/a.txt"
      })
      assert.include(out.text, "exit: 0", out.text)
      assert.include(out.text, "created /files/Shared/mara/notes/new.txt")
      assert.strictEqual(yield* Effect.promise(() => readFile(join(w.root("mara"), "notes/new.txt"), "utf8")), "new\n")
      // Checked before and measured after, like the owner's own commands.
      assert.include(w.quotaCalls, "check mara")
      assert.include(w.quotaCalls, "after mara")
      // The owner's versions, recording Ben, by the owner's paths, not tied to Ben's run.
      const theirs = w.versions.filter((v) => v.userId === "mara")
      assert.sameMembers(
        theirs.flatMap((v) => v.paths),
        ["/files/notes/new.txt", "/files/notes/a.txt"]
      )
      assert.isTrue(theirs.every((v) => v.actorUserId === "ben" && v.rolloutId === undefined))
      // Mara's open file managers are told, by her paths.
      const told = w.changed.filter((c) => c.userId === "mara").flatMap((c) => c.paths)
      assert.include(told, "/files/notes/new.txt")
      assert.notInclude(
        w.changed.filter((c) => c.userId === "ben").flatMap((c) => c.paths),
        "/files/Shared/mara/notes/new.txt"
      )
      // Over Mara's quota, her folder is read-only in Ben's commands.
      w.state.overQuota.add("mara")
      const refused = yield* w.run("ben", "bash", {
        command: "(echo x > /files/Shared/mara/notes/later.txt) 2>/dev/null || echo read-only"
      })
      assert.include(refused.text, "read-only")
      assert.include(refused.text, "over their storage limit")
      assert.isFalse(existsSync(join(w.root("mara"), "notes/later.txt")))
    }),
  120_000
)

it.live.skipIf(!commands)(
  "taking away what a running command was given stops it at once",
  () =>
    Effect.gen(function* () {
      const w = world()
      const background = (userId: string, command = "sleep 300") =>
        w.run(userId, "bash", { command, run_in_background: true }).pipe(Effect.map((out) => w.idOf(out.text)))
      // Run commands turned off.
      const first = yield* background("ben")
      w.state.grants.set("commands", "off")
      assert.strictEqual(yield* w.files.recheckCommands(["ben"]), 1)
      w.state.grants.delete("commands")
      assert.include(yield* w.ended("ben", first), "stopped: Run commands was turned off")
      // The account disabled.
      const second = yield* background("ben")
      w.state.disabled.add("ben")
      assert.strictEqual(yield* w.files.recheckCommands(["ben"]), 1)
      w.state.disabled.delete("ben")
      assert.include(yield* w.ended("ben", second), "stopped: the account was turned off")
      // A share stopped: only the command that had it is stopped.
      const shared = yield* Effect.promise(() => w.share("view"))
      const withShare = yield* background("ben")
      const other = yield* background("mara")
      w.state.shares = w.state.shares.filter((s) => s.id !== shared.id)
      assert.strictEqual(yield* w.files.recheckCommands(), 1)
      assert.include(yield* w.ended("ben", withShare), "no longer shared")
      const still = yield* w.run("mara", "bash_output", { id: other })
      assert.include(still.text, "still running")
      yield* w.run("mara", "bash_stop", { id: other })
    }),
  120_000
)

it.live.skipIf(!commands)(
  "an admin's command without a sandbox stops when the consent or the role goes, and is held together",
  () =>
    Effect.gen(function* () {
      const w = world({ allowUnsandboxed: true })
      w.state.grants.set(COMMANDS_UNSANDBOXED, "allow")
      // A grant without the server's record of the consent doesn't count.
      const plain = yield* w.run("ada", "bash", { command: "echo hi" })
      assert.notInclude(plain.text, "No sandbox")
      w.state.consented = true
      const start = yield* w.run("ada", "bash", { command: "sleep 300", run_in_background: true })
      assert.include(start.text, "Started in the background", start.text)
      const id = w.idOf(start.text)
      w.state.consented = false
      assert.strictEqual(yield* w.files.recheckCommands(["ada"]), 1)
      assert.include(yield* w.ended("ada", id), "stopped: running without a sandbox was turned off")
      w.state.consented = true
      const again = w.idOf((yield* w.run("ada", "bash", { command: "sleep 300", run_in_background: true })).text)
      w.state.role.set("ada", "user")
      assert.strictEqual(yield* w.files.recheckCommands(["ada"]), 1)
      assert.include(yield* w.ended("ada", again), "without a sandbox isn't allowed now")
    }),
  120_000
)

it.live.skipIf(!commands)(
  "background slots are taken before any wait, and ended commands are forgotten with their output",
  () =>
    Effect.gen(function* () {
      const w = world({ backgroundPerAccount: 1 })
      const results = yield* Effect.all(
        [1, 2, 3].map(() => w.run("ben", "bash", { command: "sleep 300", run_in_background: true })),
        { concurrency: "unbounded" }
      )
      const started = results.filter((r) => r.text.includes("Started in the background"))
      assert.strictEqual(started.length, 1, results.map((r) => r.text).join("\n"))
      assert.isTrue(results.filter((r) => r !== started[0]).every((r) => r.text.includes("already running")))
      // A refused start gave its slot back: once the one running stops, another starts.
      yield* w.run("ben", "bash_stop", { id: w.idOf(started[0]!.text) })
      const next = yield* w.run("ben", "bash", { command: "true", run_in_background: true })
      assert.include(next.text, "Started in the background")
      yield* w.ended("ben", w.idOf(next.text))
      assert.strictEqual(w.files.jobCount(), 2)
      yield* w.files.recheckCommands(undefined, Date.now() + 25 * 3600_000)
      assert.strictEqual(w.files.jobCount(), 0)
    }),
  120_000
)

it.live.skipIf(!commands)(
  "shared folders resolve only while they're the folder that was shared",
  () =>
    Effect.gen(function* () {
      const w = world()
      const shared = yield* Effect.promise(() => w.share("view"))
      const read = yield* w.run("ben", "read_file", { path: "/files/Shared/mara/notes/a.txt" })
      assert.include(read.text, "first")
      // Gone to the bin (and maybe back): the share is suspended until Mara shares it again (files4bfix).
      shared.suspendedAt = Date.now()
      const suspended = yield* w.run("ben", "read_file", { path: "/files/Shared/mara/notes/a.txt" })
      assert.isTrue(suspended.isError)
      const suspendedCommand = yield* w.run("ben", "bash", {
        command: "cat /files/Shared/mara/notes/a.txt 2>&1 || true"
      })
      assert.notInclude(suspendedCommand.text.split("Output")[1] ?? "", "first\n")
      // Recorded on another device: not the folder that was shared.
      shared.suspendedAt = null
      const device = shared.device
      shared.device = (device ?? 0) + 1
      assert.isTrue((yield* w.run("ben", "read_file", { path: "/files/Shared/mara/notes/a.txt" })).isError)
      shared.device = device
      assert.include((yield* w.run("ben", "read_file", { path: "/files/Shared/mara/notes/a.txt" })).text, "first")
      // Mara moves it and makes another folder of that name: neither the file tools nor commands see it.
      yield* Effect.promise(async () => {
        await rename(join(w.root("mara"), "notes"), join(w.root("mara"), "notes-old"))
        await mkdir(join(w.root("mara"), "notes"))
        await writeFile(join(w.root("mara"), "notes/private.txt"), "private")
      })
      const swapped = yield* w.run("ben", "read_file", { path: "/files/Shared/mara/notes/private.txt" })
      assert.isTrue(swapped.isError)
      assert.notInclude(swapped.text, "private")
      const listed = yield* w.run("ben", "bash", { command: "cat /files/Shared/mara/notes/private.txt 2>&1 || true" })
      assert.notInclude(listed.text.split("Output")[1] ?? "", "private\n")
      // A share without a recorded inode never resolves.
      shared.inode = null
      yield* Effect.promise(() => rename(join(w.root("mara"), "notes"), join(w.root("mara"), "notes-new")))
      yield* Effect.promise(() => rename(join(w.root("mara"), "notes-old"), join(w.root("mara"), "notes")))
      const none = yield* w.run("ben", "read_file", { path: "/files/Shared/mara/notes/a.txt" })
      assert.isTrue(none.isError)
    }),
  120_000
)

it.live.skipIf(!commands)(
  "refuses a Shared that isn't a folder, and never resolves shares of the server plugins' copies",
  () =>
    Effect.gen(function* () {
      const w = world()
      yield* Effect.promise(() => w.share("view"))
      yield* Effect.promise(async () => {
        await mkdir(w.root("ben"), { recursive: true })
        await symlink("/etc", join(w.root("ben"), "Shared"))
      })
      const refused = yield* w.run("ben", "bash", { command: "echo hi" })
      assert.isTrue(refused.isError)
      assert.include(refused.text, "/files/Shared in your files isn't a folder")
      // Plugins/Server and folders around it are never shared.
      const w2 = world()
      w2.state.role.set("mara", "admin")
      yield* Effect.promise(() => w2.share("edit", "Plugins/Server"))
      yield* Effect.promise(() => w2.share("edit", "Plugins"))
      const seen = yield* w2.run("ben", "bash", { command: "ls /files/Shared/mara 2>&1 || echo none-shared" })
      assert.include(seen.text, "none-shared")
      const read = yield* w2.run("ben", "list_files", { path: "/files/Shared/mara/Server" })
      assert.isTrue(read.isError)
    }),
  120_000
)

it.live.skipIf(!commands)(
  "Reset and commands exclude each other",
  () =>
    Effect.gen(function* () {
      const w = world()
      const id = w.idOf((yield* w.run("ben", "bash", { command: "sleep 300", run_in_background: true })).text)
      const busy = yield* w.files.resetHome("ben").pipe(Effect.flip)
      assert.include(String((busy as Error).message), "Commands are running")
      yield* w.run("ben", "bash_stop", { id })
      yield* w.ended("ben", id)
      // A home with many files takes a while to empty: a command started meanwhile is refused,
      // or runs after; its file is never removed under it.
      yield* Effect.promise(async () => {
        const home = join(w.dataDir, "env-home", "ben")
        await mkdir(join(home, "many"), { recursive: true })
        for (let i = 0; i < 3000; i++) await writeFile(join(home, "many", `f${i}`), "x")
      })
      const [, out] = yield* Effect.all(
        [w.files.resetHome("ben").pipe(Effect.exit), w.run("ben", "bash", { command: "echo kept > ~/marker" })],
        { concurrency: "unbounded" }
      )
      const marker = existsSync(join(w.dataDir, "env-home", "ben", "marker"))
      assert.isTrue(out.text.includes("being reset") || marker, out.text)
    }),
  120_000
)

it.live.skipIf(!commands)(
  "a subagent in its own copy reads the workshop's shared folders, and writes only in its copy",
  () =>
    Effect.gen(function* () {
      const w = world()
      yield* Effect.promise(async () => {
        await w.share("view")
        await mkdir(join(w.root("ben"), ".subagents/c1"), { recursive: true })
        await writeFile(join(w.root("ben"), "top.txt"), "mine\n")
      })
      const copy = { start: "/files/.subagents/c1", root: "/files/.subagents/c1" }
      const call = (id: string, args: Record<string, unknown>) =>
        w.run("ben", id, args, new Map(), copy).pipe(
          Effect.map((out) => out.text),
          Effect.catch((error) => Effect.succeed(`refused: ${String((error as Error).message ?? error)}`))
        )
      // The folder shared with the account, as the workshop reads it.
      assert.include(yield* call("read_file", { path: "/files/Shared/mara/notes/a.txt" }), "first")
      // The rest of the account's Files stays outside the copy, for reading and writing.
      assert.include(yield* call("read_file", { path: "/files/top.txt" }), "outside your copy")
      assert.include(yield* call("write_file", { path: "/files/new.txt", content: "x" }), "outside your copy")
      // A shared folder is only read by the file tools, as in the workshop.
      assert.include(
        yield* call("write_file", { path: "/files/Shared/mara/notes/b.txt", content: "x" }),
        "only read it"
      )
      assert.notInclude(
        yield* call("write_file", { path: "/files/.subagents/c1/x.txt", content: "x" }),
        "outside your copy"
      )
      assert.strictEqual(yield* Effect.promise(() => readFile(join(w.root("ben"), ".subagents/c1/x.txt"), "utf8")), "x")
      // Once the share is stopped, the subagent doesn't see it either.
      w.state.shares = []
      assert.notInclude(yield* call("read_file", { path: "/files/Shared/mara/notes/a.txt" }), "first")
    }),
  120_000
)

it.live("the app's commands for subagents' copies are running commands: Reset, revocation and the app's stop", () =>
  Effect.gen(function* () {
    const held = heldSandbox()
    const w = world({ sandbox: held.sandbox })
    yield* Effect.promise(() => mkdir(join(w.root("ben"), "notes"), { recursive: true }))
    // Making a copy: Reset waits, and Run commands turned off in its workshop stops it.
    const making = Effect.runPromise(Effect.exit(w.files.workspaces.makeCopy(w.context("ben"), "c1", "/files/notes")))
    yield* Effect.promise(() => held.started())
    const busy = yield* w.files.resetHome("ben").pipe(Effect.flip)
    assert.include(String((busy as Error).message), "Commands are running")
    w.state.grants.set("commands", "off")
    assert.strictEqual(yield* w.files.recheckCommands(["ben"]), 1)
    w.state.grants.delete("commands")
    const made = yield* Effect.promise(() => making)
    assert.strictEqual(made._tag, "Failure")
    // Checking a copy after the call (no workshop): the account turned off stops it.
    const record = { path: "/files/.subagents/c2", from: "/files/notes", kind: "files" as const }
    const checking = Effect.runPromise(w.files.workspaces.finishCopy("ben", record))
    yield* Effect.promise(() => held.started())
    w.state.disabled.add("ben")
    assert.strictEqual(yield* w.files.recheckCommands(["ben"]), 1)
    w.state.disabled.delete("ben")
    // A copy that couldn't be checked stays.
    assert.isTrue(yield* Effect.promise(() => checking))
    // The app's stop ends one too, and Reset can run after.
    const again = Effect.runPromise(w.files.workspaces.finishCopy("ben", record))
    yield* Effect.promise(() => held.started())
    w.files.stopAll()
    assert.isTrue(yield* Effect.promise(() => again))
    yield* w.files.resetHome("ben")
  })
)
