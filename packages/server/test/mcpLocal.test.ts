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
import { LOCAL_PROGRAMS_OFF } from "../src/mcp/stdio.ts"
import { linuxBwrap } from "../src/sandbox/linuxBwrap.ts"
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
  { name: "crash", inputSchema: { type: "object" } }
]
rl.on("line", (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  if (m.method === "initialize")
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-local", version: "1" } } })
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } })
  if (m.method === "tools/call") {
    if (m.params.name === "crash") { process.stderr.write("crashing now\\n"); process.exit(3) }
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
        assert.strictEqual(created.connection.toolCount, 3)
        assert.deepStrictEqual(created.connection.program?.command, "node")
        const id = created.connection.id
        // Its own variables; the app's own reserved names are refused.
        assert.strictEqual(
          (yield* admin.api
            .SetMcpEnvironment({
              connectionId: id,
              env: { PATH: "/evil" },
              expectedRowVersion: created.connection.rowVersion
            })
            .pipe(Effect.flip))._tag,
          "McpRefused"
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

        // Its stderr, for its own user only.
        const output = yield* admin.api.GetMcpProgramOutput({ connectionId: id })
        assert.isTrue(output.running)
        assert.include(output.output, "fake local server ready")
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

        // Shared, each user runs their own copy, in their own folder.
        yield* admin.api.SetMcpShare({ connectionId: id, scope: "chosen", userIds: [bob.id] })
        const bobs = yield* callAs(bob.id, id, "env")
        assert.strictEqual(bobs._tag, "Result")
        assert.isTrue((yield* bob.api.GetMcpProgramOutput({ connectionId: id })).running)
        const bobView = yield* bob.api.GetMcpConnection({ connectionId: id })
        assert.isNull(bobView.program)
        assert.deepStrictEqual(bobView.envNames, [])
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ mcpLocalPrograms: true }))))
  )
})
