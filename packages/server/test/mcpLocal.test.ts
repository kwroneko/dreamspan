// Local programs as MCP servers (spec/MCP.md §2.2, M6): refused without MCP_LOCAL_PROGRAMS and
// for anyone but an admin (the RPC and the database's triggers), and, where the Linux sandbox can
// run, a real program in it: its tools, its clean environment, its stderr, an idle stop by its
// PID, and a crash under a call recorded as interrupted. The program is a few lines of Node given
// with `node -e`; it never reaches the network.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { McpConnectionSettings } from "@dreamspan/shared/mcp.ts"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { McpConnections, mcpClientTiming } from "../src/mcp/McpConnections.ts"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_PROGRAMS_OFF, programLimits } from "../src/mcp/stdio.ts"
import { linuxBwrap, sandboxPath } from "../src/sandbox/linuxBwrap.ts"
import { client, login, serverLayer, testConfig } from "./support/config.ts"

const state = await linuxBwrap.available()
const skipReason = state.ok ? null : `${state.reason} ${state.fix ?? ""}`
if (skipReason) console.warn(`mcpLocal: sandboxed runs skipped, the sandbox isn't available here: ${skipReason}`)

/** A tiny MCP server over stdio: echo, env (what it sees) and crash (exits mid-call). */
const PROGRAM = `
const rl = require("readline").createInterface({ input: process.stdin })
process.stderr.write("fake local server ready\\n")
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
const tools = [
  { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "env", inputSchema: { type: "object" } },
  { name: "crash", inputSchema: { type: "object" } },
  { name: "leak", inputSchema: { type: "object" } },
  { name: "big", inputSchema: { type: "object" } }
]
rl.on("line", (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  if (m.method === "initialize")
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-local", version: "1" } } })
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } })
  if (m.method === "tools/call") {
    if (m.params.name === "crash") { process.stderr.write("crashing now\\n"); process.exit(3) }
    if (m.params.name === "leak") process.stderr.write("auth failed with token " + process.env.NOTES_TOKEN + "\\n")
    if (m.params.name === "big") return process.stdout.write("x".repeat(9 * 1024 * 1024))
    const text = m.params.name === "env"
      ? JSON.stringify({ env: process.env, cwd: process.cwd(), uid: process.getuid() })
      : String(m.params.arguments.text)
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } })
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } })
})
`

const settings = (name = "Local notes"): McpConnectionSettings => ({
  name,
  about: "A local test program",
  transport: "stdio",
  url: "",
  program: { command: "node", args: ["-e", PROGRAM] },
  timeoutS: 10
})

const callAs = (userId: UserId, connectionId: string, tool: string, args: unknown = {}) =>
  Effect.flatMap(McpConnections, (mcp) =>
    mcp.call({
      userId,
      connectionId: connectionId as never,
      tool,
      args,
      attribution: { purpose: "workshop", chatId: null, rolloutId: null, toolCallId: null, attempt: 1 }
    })
  )

const textOf = (outcome: { readonly _tag: string; readonly result?: unknown }) =>
  (outcome.result as { content: Array<{ text: string }> }).content[0]!.text

/** The admin and a user, each with a client of their own. */
const people = Effect.gen(function* () {
  const local = yield* client()
  const admin = yield* local.Whoami()
  yield* local.SetPassword({ userId: admin.id, currentPassword: null, newPassword: "admin-password" })
  const adminApi = yield* client({ cookie: (yield* login(admin.handle, "admin-password")).cookie })
  const bob = yield* adminApi.CreateUser({ handle: "bob", displayName: "bob", role: "user", password: "bob-password" })
  const bobApi = yield* client({ cookie: (yield* login("bob", "bob-password")).cookie })
  return { admin: { id: admin.id as UserId, api: adminApi }, bob: { id: bob.id as UserId, api: bobApi } }
})

describe("local programs", () => {
  it.live("are refused without the instance switch, for everyone", () =>
    Effect.gen(function* () {
      const { admin } = yield* people
      const gate = yield* admin.api.GetMcpLocalPrograms()
      assert.deepStrictEqual(gate, { allowed: false, reason: LOCAL_PROGRAMS_OFF })
      const refused = yield* admin.api.CreateMcpConnection({ settings: settings() }).pipe(Effect.flip)
      assert.strictEqual(refused._tag, "McpRefused")
      assert.strictEqual((refused as { message: string }).message, LOCAL_PROGRAMS_OFF)
      assert.lengthOf(yield* admin.api.ListMcpConnections(), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("are an admin's only: the RPC refuses first, and the database refuses too", () =>
    Effect.gen(function* () {
      const { bob } = yield* people
      const gate = yield* bob.api.GetMcpLocalPrograms()
      assert.isFalse(gate.allowed)
      assert.strictEqual(gate.reason, "Only an admin can add a local program.")
      const refused = yield* bob.api.CreateMcpConnection({ settings: settings() }).pipe(Effect.flip)
      assert.strictEqual(refused._tag, "McpRefused")
      // A remote server of Bob's can't become a local program either.
      const own = yield* bob.api.CreateMcpConnection({
        settings: { ...settings("Remote"), transport: "streamable-http", url: "http://127.0.0.1:9/mcp" }
      })
      const changed = yield* bob.api
        .UpdateMcpConnection({
          connectionId: own.connection.id,
          settings: settings("Remote"),
          expectedRowVersion: own.connection.rowVersion
        })
        .pipe(Effect.flip)
      assert.strictEqual(changed._tag, "McpRefused")
      // Straight to the writer, past the RPC: the trigger refuses it.
      const writer = yield* Writer
      const direct = yield* writer
        .CreateMcpConnection({
          userId: bob.id,
          connectionId: "019a0000-0000-7000-8000-00000000abcd" as never,
          settings: settings(),
          credential: { existing: null },
          at: Date.now()
        })
        .pipe(Effect.flip)
      assert.strictEqual(direct._tag, "StorageError")
      const update = yield* writer
        .UpdateMcpConnection({
          userId: bob.id,
          connectionId: own.connection.id,
          settings: settings("Remote"),
          expectedRowVersion: (yield* bob.api.GetMcpConnection({ connectionId: own.connection.id })).rowVersion,
          at: Date.now()
        })
        .pipe(Effect.flip)
      assert.strictEqual(update._tag, "StorageError")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ mcpLocalPrograms: true }))))
  )

  it.live.skipIf(skipReason !== null)(
    "run sandboxed with a clean environment, keep their stderr, stop when idle, and a crash under a call is interrupted",
    () =>
      Effect.gen(function* () {
        const before = mcpClientTiming.idleMs
        mcpClientTiming.idleMs = 400
        yield* Effect.addFinalizer(() => Effect.sync(() => (mcpClientTiming.idleMs = before)))
        process.env.DREAMSPAN_TEST_LEAK = "app-environment-secret"
        yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env.DREAMSPAN_TEST_LEAK))
        const { admin, bob } = yield* people
        assert.deepStrictEqual(yield* admin.api.GetMcpLocalPrograms(), { allowed: true, reason: null })
        // A key is a remote server's; a program gets variables instead.
        assert.strictEqual(
          (yield* admin.api.CreateMcpConnection({ settings: settings(), apiKey: "sk-nope" }).pipe(Effect.flip))._tag,
          "McpRefused"
        )
        const created = yield* admin.api.CreateMcpConnection({ settings: settings() })
        assert.isTrue(created.check.ok, created.check.detail)
        assert.strictEqual(created.connection.toolCount, 5)
        assert.deepStrictEqual(created.connection.program?.command, "node")
        const id = created.connection.id
        // Its own variables; the app's own reserved names, and those that change how a shell,
        // the linker or a runtime starts, are refused.
        for (const name of ["PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "NODE_OPTIONS", "PYTHONSTARTUP", "PERL5OPT"])
          assert.strictEqual(
            (yield* admin.api
              .SetMcpEnvironment({
                connectionId: id,
                env: { [name]: "/home/user/x" },
                expectedRowVersion: created.connection.rowVersion
              })
              .pipe(Effect.flip))._tag,
            "McpRefused",
            name
          )
        const withEnv = yield* admin.api.SetMcpEnvironment({
          connectionId: id,
          env: { NOTES_TOKEN: "program-secret-value" },
          expectedRowVersion: created.connection.rowVersion
        })
        assert.deepStrictEqual(withEnv.envNames, ["NOTES_TOKEN"])
        assert.notInclude(JSON.stringify(withEnv), "program-secret-value")

        const echoed = yield* callAs(admin.id, id, "echo", { text: "hello" })
        assert.strictEqual(echoed._tag, "Result")
        assert.strictEqual(textOf(echoed), "hello")
        const seen = JSON.parse(textOf(yield* callAs(admin.id, id, "env"))) as {
          env: Record<string, string>
          cwd: string
        }
        // Only these: nothing of the app's own environment.
        assert.sameMembers(
          Object.keys(seen.env).filter((name) => !/^(HTTPS?|ALL|NO)_PROXY$/i.test(name)),
          ["PATH", "HOME", "LANG", "NOTES_TOKEN"]
        )
        // The proxy variables are the sandbox's one way out (ARCHITECTURE §18).
        assert.match(seen.env.HTTPS_PROXY ?? "", /^http:\/\/127\.0\.0\.1:/)
        assert.strictEqual(seen.env.HOME, "/home/user")
        assert.strictEqual(seen.env.LANG, "C.UTF-8")
        assert.strictEqual(seen.env.NOTES_TOKEN, "program-secret-value")
        assert.strictEqual(seen.cwd, "/home/user")
        assert.notInclude(textOf(yield* callAs(admin.id, id, "env")), "app-environment-secret")

        // Its stderr, for its own user only, with the variables' values scrubbed.
        assert.strictEqual((yield* callAs(admin.id, id, "leak"))._tag, "Result")
        const output = yield* admin.api.GetMcpProgramOutput({ connectionId: id })
        assert.isTrue(output.running)
        assert.include(output.output, "fake local server ready")
        assert.include(output.output, "auth failed with token [redacted]")
        assert.notInclude(output.output, "program-secret-value")
        assert.strictEqual(
          (yield* bob.api.GetMcpProgramOutput({ connectionId: id }).pipe(Effect.flip))._tag,
          "NotFound"
        )

        // Idle: the process stops, by its PID's group.
        yield* Effect.sleep("1200 millis")
        assert.isFalse((yield* admin.api.GetMcpProgramOutput({ connectionId: id })).running)
        assert.strictEqual((yield* McpConnections).kept(), 0)

        // A crash under a call: interrupted, in the result and the ledger; the next call starts it again.
        const crashed = yield* callAs(admin.id, id, "crash")
        assert.strictEqual(crashed._tag, "Failed")
        if (crashed._tag === "Failed") {
          assert.strictEqual(crashed.status, "interrupted")
          assert.isTrue(crashed.sent)
          assert.include(crashed.message, "exit code 3")
        }
        const ledger = yield* admin.api.ListMcpCalls({ connectionId: id, before: null })
        assert.strictEqual(ledger.find((row) => row.tool === "crash")?.status, "interrupted")
        assert.include((yield* admin.api.GetMcpProgramOutput({ connectionId: id })).output, "crashing now")
        assert.strictEqual(textOf(yield* callAs(admin.id, id, "echo", { text: "again" })), "again")

        // A message over the limit ends its call and stops the program; the server carries on,
        // and the next call starts it again.
        const big = yield* callAs(admin.id, id, "big")
        assert.strictEqual(big._tag, "Failed")
        if (big._tag === "Failed") {
          assert.strictEqual(big.status, "interrupted")
          assert.include(big.message, "longer than 8 MB")
        }
        assert.include((yield* admin.api.GetMcpProgramOutput({ connectionId: id })).output, "longer than 8 MB")
        assert.strictEqual(textOf(yield* callAs(admin.id, id, "echo", { text: "still here" })), "still here")

        // Shared, each user runs their own copy, in their own folder; its output, which prints
        // the admin's configuration, isn't theirs to read.
        yield* admin.api.SetMcpShare({ connectionId: id, scope: "chosen", userIds: [bob.id] })
        const bobs = yield* callAs(bob.id, id, "leak")
        assert.strictEqual(bobs._tag, "Result")
        assert.strictEqual(
          (yield* bob.api.GetMcpProgramOutput({ connectionId: id }).pipe(Effect.flip))._tag,
          "NotFound"
        )
        const bobView = yield* bob.api.GetMcpConnection({ connectionId: id })
        assert.isNull(bobView.program)
        assert.deepStrictEqual(bobView.envNames, [])
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ mcpLocalPrograms: true }))))
  )

  it.live.skipIf(skipReason !== null)(
    "a program's own variables reach it only after the sandbox's limits are set: none acts on its first shell",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "mcp-env-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
        )
        // A file from an earlier run that the shell would source before its limits.
        yield* Effect.promise(() =>
          writeFile(join(home, "rc.sh"), "ulimit -n 999999 2>/dev/null; touch /home/user/sourced\n")
        )
        const child = yield* Effect.promise(() =>
          linuxBwrap.spawn!({
            argv: [
              "node",
              "-e",
              `const fs = require("fs"); process.stdout.write(JSON.stringify({ bashEnv: process.env.BASH_ENV, token: process.env.NOTES_TOKEN, path: process.env.PATH, sourced: fs.existsSync("/home/user/sourced"), files: fs.readFileSync("/proc/self/limits", "utf8").split("\\n").find((l) => l.startsWith("Max open files")) }) + "\\n")`
            ],
            cwd: "/home/user",
            mounts: [{ source: home, target: "/home/user", writable: true }],
            env: { PATH: sandboxPath(), HOME: "/home/user", LANG: "C.UTF-8" },
            // Past the RPC's checks (as a row stored before them would be): still inert for the shell.
            programEnv: { BASH_ENV: "/home/user/rc.sh", NOTES_TOKEN: "t0ken", PATH: "/evil" },
            network: "none",
            limits: { ...programLimits, reserve: { bytes: 0, inodes: 0 } }
          })
        )
        const chunks: Array<Buffer> = []
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
        const end = yield* Effect.promise(() => child.exited)
        assert.strictEqual(end.exitCode, 0)
        const seen = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
        assert.strictEqual(seen.bashEnv, "/home/user/rc.sh")
        assert.strictEqual(seen.token, "t0ken")
        assert.strictEqual(seen.path, sandboxPath())
        assert.isFalse(seen.sourced)
        assert.match(String(seen.files), /\b4096\b/)
        const files = yield* Effect.promise(() => readFile(join(home, "rc.sh"), "utf8"))
        assert.include(files, "touch")
      })
  )

  it.live.skipIf(skipReason !== null)(
    "a program keeps the disk reserve: it doesn't start below it, and stops when the disk goes below",
    () =>
      Effect.gen(function* () {
        const before = programLimits.reserve
        yield* Effect.addFinalizer(() => Effect.sync(() => (programLimits.reserve = before)))
        const { admin } = yield* people
        const created = yield* admin.api.CreateMcpConnection({ settings: settings() })
        const id = created.connection.id
        assert.strictEqual(textOf(yield* callAs(admin.id, id, "echo", { text: "room" })), "room")
        // The disk "fills": more free space than any disk has is now the reserve.
        programLimits.reserve = { bytes: Number.MAX_SAFE_INTEGER, inodes: 0 }
        yield* Effect.sleep("1500 millis")
        const output = yield* admin.api.GetMcpProgramOutput({ connectionId: id })
        assert.isFalse(output.running)
        assert.include(output.output, "nearly full")
        const refused = yield* callAs(admin.id, id, "echo", { text: "no room" })
        assert.strictEqual(refused._tag, "Failed")
        if (refused._tag === "Failed") assert.include(refused.message, "nearly full")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ mcpLocalPrograms: true }))))
  )
})
