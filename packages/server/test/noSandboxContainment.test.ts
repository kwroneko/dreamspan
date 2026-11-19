// The `none` sandbox (spec/FILES-AND-ENVIRONMENT.md §3.7) holds each command's processes
// together: a process that left the command's process group (`setsid prog &`) still ends with the
// command, when it's stopped and when it ends by itself, in a cgroup or scope where the host has
// one and in a PID namespace where it doesn't. Without either, it says why (the file tools then
// refuse background commands without a sandbox).
import { readdirSync, readFileSync } from "node:fs"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeRegistry } from "@dreamspan/shared/registry.ts"
import { makeNoSandbox, noSandbox } from "../src/sandbox/none.ts"
import type { CommandSandbox, RunSpec } from "../src/sandbox/registry.ts"

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
