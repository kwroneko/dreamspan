// The `none` sandbox (spec/FILES-AND-ENVIRONMENT.md §3.7) holds each command's processes
// together: a process that left the command's process group (`setsid prog &`) still ends with the
// command, when it's stopped and when it ends by itself, in a cgroup or scope where the host has
// one and in a PID namespace where it doesn't. Without either, it says why (the file tools then
// refuse background commands without a sandbox). When the cgroup can't be opened for a command,
// its PID namespace is used instead; with neither, a command that must be held is refused.
import { readdirSync, readFileSync } from "node:fs"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeRegistry } from "@dreamspan/shared/registry.ts"
import { makeNoSandbox, noSandbox } from "../src/sandbox/none.ts"
import { selectLimiter, type CgroupLimiter } from "../src/sandbox/cgroupLimits.ts"
import type { CommandSandbox, RunSpec } from "../src/sandbox/registry.ts"
import { CommandRefused } from "../src/sandbox/refused.ts"

const alive = (marker: string) =>
  readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(marker)
      } catch {
        return false
      }
    })

const spec = (command: string): RunSpec => ({
  command,
  cwd: "/tmp",
  mounts: [],
  env: { HOME: "/tmp" },
  network: "none",
  limits: { timeoutMs: 20_000, processes: 64, memoryBytes: 2 ** 30, fileBytes: 2 ** 30, openFiles: 1024 }
})

const escapes = (sandbox: CommandSandbox) =>
  Effect.promise(async () => {
    const contained = await sandbox.containment!()
    assert.isTrue(contained.ok, JSON.stringify(contained))
    // Ends by itself, leaving a process outside its group.
    const ended = `ended${Date.now()}`
    const result = await sandbox.run(
      spec(`setsid sh -c 'sleep 300; :' ${ended} >/dev/null 2>&1 & echo started`),
      new AbortController().signal
    )
    assert.strictEqual(result.exitCode, 0)
    assert.include(result.head, "started")
    await new Promise((done) => setTimeout(done, 300))
    assert.deepStrictEqual(alive(ended), [])
    // Stopped while it runs.
    const stopped = `stopped${Date.now()}`
    const controller = new AbortController()
    const running = sandbox.run(
      spec(`setsid sh -c 'sleep 300; :' ${stopped} >/dev/null 2>&1 & sleep 300`),
      controller.signal
    )
    await new Promise((done) => setTimeout(done, 500))
    assert.isNotEmpty(alive(stopped))
    controller.abort()
    await running
    await new Promise((done) => setTimeout(done, 300))
    assert.deepStrictEqual(alive(stopped), [])
  })

const linux = process.platform === "linux"

it.live.skipIf(!linux)("collects a successful shell's output when a helper inherits its pipe", () =>
  Effect.promise(async () => {
    const limiter: CgroupLimiter = {
      id: "test",
      explanation: "Uses the command's process group for this test",
      available: async () => ({ ok: true }),
      open: async () => ({
        wrap: (file, args) => ({ file, args: [...args] }),
        env: {},
        kill: async () => {},
        finish: async () => ({ memoryCapped: false })
      })
    }
    const command = spec("sleep 3 & printf 'shell done\\n'")
    const result = await makeNoSandbox(makeRegistry([limiter])).run(
      { ...command, limits: { ...command.limits, timeoutMs: 1000 } },
      new AbortController().signal
    )
    assert.isFalse(result.timedOut)
    assert.strictEqual(result.exitCode, 0)
    assert.include(result.head, "shell done")
  })
)

it.live.skipIf(!linux)(
  "ends what a command left behind, in a cgroup where there is one",
  () => escapes(noSandbox),
  60_000
)

it.live.skipIf(!linux)(
  "ends what a command left behind, in a PID namespace without a cgroup",
  () => escapes(makeNoSandbox(makeRegistry([]))),
  60_000
)

it.live.skipIf(!linux)("says why when nothing can hold commands together", () =>
  Effect.promise(async () => {
    const path = process.env.PATH
    process.env.PATH = "/nonexistent"
    try {
      const contained = await makeNoSandbox(makeRegistry([])).containment!()
      assert.isFalse(contained.ok)
      if (!contained.ok) assert.include(contained.reason, "can't be held together")
    } finally {
      process.env.PATH = path
    }
  })
)

/** A limiter that says it works but can't open a group (a transient failure). */
const broken: CgroupLimiter = {
  id: "broken",
  explanation: "fails to open",
  available: async () => ({ ok: true }),
  open: () => Promise.reject(new Error("no group"))
}

it.live.skipIf(!linux)(
  "falls back to a PID namespace when a command's cgroup can't be opened",
  () => escapes(makeNoSandbox(makeRegistry([broken]))),
  60_000
)

it.live("shares an in-flight cgroup probe among callers", () =>
  Effect.promise(async () => {
    const gate = Promise.withResolvers<{ ok: true }>()
    let probes = 0
    const limiter: CgroupLimiter = {
      ...broken,
      available: () => {
        probes++
        return gate.promise
      }
    }
    const registry = makeRegistry([limiter])
    const first = selectLimiter(registry)
    const second = selectLimiter(registry)
    gate.resolve({ ok: true })
    assert.deepStrictEqual(await Promise.all([first, second]), [limiter, limiter])
    assert.strictEqual(probes, 1)
  })
)

it.live.skipIf(!linux)("refuses a command that must be held when neither a cgroup nor a namespace can be had", () =>
  Effect.promise(async () => {
    const sandbox = makeNoSandbox(makeRegistry([broken]))
    const path = process.env.PATH
    process.env.PATH = "/nonexistent"
    try {
      // containment() still says a cgroup is there; the failure is this command's.
      assert.isTrue((await sandbox.containment!()).ok)
      const refused = await sandbox
        .run({ ...spec("echo ran"), requireContainment: true }, new AbortController().signal)
        .then(
          () => null,
          (error: unknown) => error
        )
      assert.instanceOf(refused, CommandRefused)
      assert.include((refused as Error).message, "can't be held together")
      // A foreground command still runs, with its process group only.
      const ran = await sandbox.run(spec("echo ran"), new AbortController().signal)
      assert.include(ran.head, "ran")
    } finally {
      process.env.PATH = path
    }
  })
)
