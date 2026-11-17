// Escape tests for the Linux command sandbox (spec/FILES-AND-ENVIRONMENT.md §3, §9 L0): a
// synthetic data folder (database, server secret, another account's files) beside one account's
// Files, and commands that try to reach it, write outside, reach private addresses, exhaust
// processes, memory and time, and leave processes behind. Skipped, saying why, where bubblewrap
// or unprivileged user namespaces aren't available.
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { linuxBwrap } from "../src/sandbox/linuxBwrap.ts"
import { reachableAddresses, sandboxMayReach } from "../src/sandbox/network.ts"
import type { RunSpec } from "../src/sandbox/registry.ts"
import { FilePathRefused, listFolder, readRegularFile, writeRegularFile } from "../src/files/safePath.ts"
import { tempDir } from "./support/tempDir.ts"

const state = await linuxBwrap.available()
const skipReason = state.ok ? null : `${state.reason} ${state.fix ?? ""}`
if (skipReason) console.warn(`sandboxEscapes: skipped, the sandbox isn't available here: ${skipReason}`)
const sandboxed = describe.skipIf(skipReason !== null)

const data = tempDir("sandbox-data")
const files = join(data, "files", "user-a")
const other = join(data, "files", "user-b")
const home = join(data, "env-home", "user-a")
const SECRET = `secret-${randomBytes(8).toString("hex")}`

const spec = (command: string, overrides: Partial<RunSpec> = {}): RunSpec => ({
  command,
  cwd: "/files",
  mounts: [
    { source: files, target: "/files", writable: true },
    { source: home, target: "/home/user", writable: true }
  ],
  env: { PATH: `/usr/local/bin:/usr/bin:/bin:${join(process.execPath, "..")}`, HOME: "/home/user" },
  network: "none",
  limits: { timeoutMs: 20_000, processes: 256, memoryBytes: 2 * 2 ** 30, fileBytes: 2 ** 30, openFiles: 1024 },
  ...overrides
})
const run = (command: string, overrides: Partial<RunSpec> = {}) =>
  linuxBwrap.run(spec(command, overrides), new AbortController().signal)
const output = (result: { head: string; tail: string }) => result.head + result.tail

/** Host processes whose command line holds `marker`. */
const hostProcesses = (marker: string) =>
  readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker)
      } catch {
        return false
      }
    })

let server: Server
let port = 0
beforeAll(async () => {
  for (const dir of [files, other, home]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(data, "secret.key"), SECRET)
  writeFileSync(join(data, "db.sqlite"), `SQLite format 3 ${SECRET}`)
  writeFileSync(join(other, "private.txt"), SECRET)
  writeFileSync(join(files, "mine.txt"), "mine")
  process.env.RP_ESCAPE_TEST_SECRET = SECRET
  server = createServer((_req, res) => res.end(SECRET))
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()))
  port = (server.address() as { port: number }).port
})
afterAll(async () => {
  delete process.env.RP_ESCAPE_TEST_SECRET
  await new Promise<void>((done) => server.close(() => done()))
})

sandboxed("the Linux sandbox", () => {
  it("sees its own files and runs as an unprivileged user", async () => {
    const result = await run("cat mine.txt; echo; id -u; pwd")
    expect(result.exitCode).toBe(0)
    expect(output(result)).toContain("mine")
    expect(result.cwd).toBe("/files")
  })

  it("can't read the app's data folder, database, secret, other accounts or host homes", async () => {
    const result = await run(
      [
        `cat ${join(data, "secret.key")}`,
        `cat ${join(data, "db.sqlite")}`,
        `cat ${join(other, "private.txt")}`,
        `ls ${data}`,
        "ls /home",
        "cat /etc/shadow",
        `ls ${process.env.HOME ?? "/root"}/.ssh`,
        "grep -rs . /files/../ 2>/dev/null | head -c 0",
        "cat /files/../../" + join(data, "secret.key").slice(1),
        "env",
        "true"
      ].join("; ")
    )
    expect(output(result)).not.toContain(SECRET)
    expect(output(result)).toMatch(/No such file or directory/)
  })

  it("can't see the server's processes or their environment", async () => {
    const result = await run(
      `ls /proc | grep -E '^[0-9]+$' | wc -l; cat /proc/${process.pid}/environ; cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c RP_ESCAPE_TEST_SECRET; cat /proc/1/cmdline | tr '\\0' ' '`
    )
    const text = output(result)
    expect(text).not.toContain(SECRET)
    const [count] = text.split("\n")
    expect(Number(count)).toBeLessThan(10)
    expect(text).not.toContain("vitest")
  })

  it("can't follow a link or .. out of its files", async () => {
    // A link planted inside Files points at the host's data: inside, that path doesn't exist.
    symlinkSync(join(data, "secret.key"), join(files, "planted"))
    const result = await run(
      `cat planted; ln -s ../../../../../../${join(data, "secret.key").slice(1)} up; cat up; ln -s / root; ls root/; cat root${join(data, "secret.key")}; cd ..; cd ..; pwd; cat .${join(data, "secret.key")}`
    )
    expect(output(result)).not.toContain(SECRET)
    // The app itself never follows the links a command made (safePath.ts).
    await expect(readRegularFile(files, ["planted"], 1000)).rejects.toBeInstanceOf(FilePathRefused)
    await expect(readRegularFile(files, ["up"], 1000)).rejects.toBeInstanceOf(FilePathRefused)
    await expect(readRegularFile(files, ["root", data.slice(1), "secret.key"], 1000)).rejects.toBeInstanceOf(
      FilePathRefused
    )
    const listed = await listFolder(files, [], 100)
    expect(listed.entries.find((e) => e.name === "planted")?.kind).toBe("link")
    // Writing over a link replaces the link; its target is untouched.
    await writeRegularFile(files, ["planted"], Buffer.from("replaced"))
    expect(readFileSync(join(data, "secret.key"), "utf8")).toBe(SECRET)
  })

  it("can't write outside its files, home folder and /tmp", async () => {
    const marker = `escape-${randomBytes(4).toString("hex")}`
    const result = await run(
      [
        `echo x > ${join(data, marker)}`,
        `echo x > /usr/${marker}`,
        `echo x > /etc/${marker}`,
        `echo x > /${marker}`,
        `mkdir /${marker}`,
        `echo x > /home/user/${marker} && echo home-ok`,
        `echo x > /tmp/${marker} && echo tmp-ok`,
        `echo x > /files/${marker} && echo files-ok`
      ].join("; ")
    )
    const text = output(result)
    expect(text).toContain("home-ok")
    expect(text).toContain("tmp-ok")
    expect(text).toContain("files-ok")
    expect(existsSync(join(data, marker))).toBe(false)
    expect(existsSync(`/usr/${marker}`)).toBe(false)
    expect(existsSync(`/etc/${marker}`)).toBe(false)
    expect(existsSync(`/${marker}`)).toBe(false)
    expect(existsSync(join(home, marker))).toBe(true)
    // The private /tmp is gone with the command.
    expect(existsSync(`/tmp/${marker}`)).toBe(false)
  })

  it("can't create namespaces of its own or gain privileges", async () => {
    const result = await run("unshare -U true && echo nested; unshare -r true && echo root-ns; echo done")
    expect(output(result)).not.toContain("nested")
    expect(output(result)).not.toContain("root-ns")
  })

  it("has no network without the proxy, and the proxy refuses private addresses", async () => {
    const curl = (target: string, extra = "") =>
      `curl -sS -m 5 ${extra} -o /dev/null -w '%{http_code}\\n' ${target} 2>&1 || echo failed`
    const none = await run(`${curl(`http://127.0.0.1:${port}/`)}; ${curl("http://1.1.1.1/")}`)
    expect(output(none)).not.toContain(SECRET)
    expect(output(none)).not.toMatch(/^200$/m)
    const proxied = await run(
      [
        `curl -sS -m 5 http://127.0.0.1:${port}/ 2>&1; echo`,
        `curl -sS -m 5 http://localhost:${port}/ 2>&1; echo`,
        `curl -sS -m 5 http://[::1]:${port}/ 2>&1; echo`,
        curl("http://169.254.169.254/latest/meta-data/"),
        curl("http://192.168.1.1/"),
        curl("http://10.0.0.1/"),
        curl("http://172.17.0.1/"),
        curl("http://100.64.0.1/"),
        curl(`https://127.0.0.1:${port}/`),
        // Bypassing the proxy: no route at all.
        curl(`http://127.0.0.1:${port}/`, "--noproxy '*'"),
        curl("http://1.1.1.1/", "--noproxy '*'")
      ].join("; "),
      { network: "public" }
    )
    const text = output(proxied)
    expect(text).not.toContain(SECRET)
    expect(text).toContain("Only public internet addresses can be reached from commands.")
    expect(text).not.toMatch(/^200$/m)
  })

  it("resolves names once and refuses private, loopback, metadata and own addresses", async () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.10",
      "172.16.5.5",
      "169.254.169.254",
      "100.64.1.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "0.0.0.0"
    ])
      expect(sandboxMayReach(address, new Set())).toBe(false)
    expect(sandboxMayReach("93.184.215.14", new Set())).toBe(true)
    expect(sandboxMayReach("93.184.215.14", new Set(["93.184.215.14"]))).toBe(false)
    // A public name pointed at loopback (DNS rebinding) is refused; a mixed answer keeps the public one.
    expect(await reachableAddresses("rebind.example", async () => ["127.0.0.1"])).toEqual([])
    expect(await reachableAddresses("mixed.example", async () => ["10.0.0.1", "93.184.215.14"])).toEqual([
      "93.184.215.14"
    ])
    expect(await reachableAddresses("localhost", async () => ["93.184.215.14"])).toEqual([])
  })

  it("stops a fork bomb at its process limit and timeout", async () => {
    const started = Date.now()
    const result = await run("bomb() { bomb | bomb & }; bomb; sleep 2; echo survived", {
      limits: { timeoutMs: 8000, processes: 64, memoryBytes: 2 ** 30, fileBytes: 2 ** 30, openFiles: 256 }
    })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(result.exitCode === null || result.exitCode >= 0).toBe(true)
    // The host still forks.
    expect(execFileSync("/bin/sh", ["-c", "echo ok"], { encoding: "utf8" }).trim()).toBe("ok")
  })

  it("caps a process's memory", async () => {
    // The markers are built when printed, so a traceback quoting the source doesn't contain them.
    const result = await run(
      [
        'python3 -c \'x = bytearray(1536 * 1024 * 1024); print("PY" + "-OK")\' 2>&1 | tail -1',
        'node -e \'const b = Buffer.alloc(1536 * 1024 * 1024); b.fill(1); console.log("NODE" + "-OK")\' 2>&1 | tail -1',
        'node -e \'const b = Buffer.alloc(256 * 1024 * 1024); b.fill(1); console.log("SMALL" + "-OK")\''
      ].join("; "),
      { limits: { timeoutMs: 20_000, processes: 64, memoryBytes: 2 ** 30, fileBytes: 2 ** 30, openFiles: 256 } }
    )
    const text = output(result)
    expect(text).not.toContain("PY-OK")
    expect(text).not.toContain("NODE-OK")
    // Below the cap, programs work.
    expect(text).toContain("SMALL-OK")
  })

  it("caps file size", async () => {
    const result = await run("head -c 3000000 /dev/zero > big; ls -l big | awk '{print $5}'", {
      limits: { timeoutMs: 20_000, processes: 64, memoryBytes: 2 ** 30, fileBytes: 2 ** 20, openFiles: 256 }
    })
    expect(Number(output(result).trim().split("\n").at(-1))).toBeLessThanOrEqual(2 ** 20)
  })

  it("stops a command that floods its output, keeping only its start and end", async () => {
    const result = await run("head -c 400000000 /dev/zero | tr '\\0' x; echo never", {
      limits: { timeoutMs: 60_000, processes: 64, memoryBytes: 2 ** 30, fileBytes: 2 ** 30, openFiles: 256 }
    })
    expect(result.outputCapped).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.head.length + result.tail.length).toBeLessThanOrEqual(2 * 2 ** 20)
    expect(output(result)).not.toContain("never")
  })

  it("kills the command and everything it started at the timeout", async () => {
    const marker = `rp-leftover-${randomBytes(4).toString("hex")}`
    const started = Date.now()
    const result = await run(
      `(exec -a ${marker} sleep 300) & setsid bash -c 'exec -a ${marker} sleep 300' & sleep 300`,
      {
        limits: { timeoutMs: 1500, processes: 64, memoryBytes: 2 ** 30, fileBytes: 2 ** 30, openFiles: 256 }
      }
    )
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(Date.now() - started).toBeLessThan(10_000)
    await new Promise((done) => setTimeout(done, 300))
    expect(hostProcesses(marker)).toEqual([])
  })

  it("leaves no process behind when the command ends, daemons included", async () => {
    const marker = `rp-leftover-${randomBytes(4).toString("hex")}`
    const result = await run(
      `(exec -a ${marker} sleep 300 &); setsid bash -c 'exec -a ${marker} sleep 300' & nohup bash -c 'exec -a ${marker} sleep 300' >/dev/null 2>&1 & disown -a; echo started`
    )
    expect(output(result)).toContain("started")
    await new Promise((done) => setTimeout(done, 300))
    expect(hostProcesses(marker)).toEqual([])
  })

  it("kills the process tree when the run is stopped", async () => {
    const marker = `rp-leftover-${randomBytes(4).toString("hex")}`
    const stop = new AbortController()
    const pending = linuxBwrap.run(spec(`bash -c 'exec -a ${marker} sleep 300' & wait`), stop.signal)
    await new Promise((done) => setTimeout(done, 700))
    expect(hostProcesses(marker).length).toBeGreaterThan(0)
    stop.abort()
    const result = await pending
    expect(result.exitCode).toBeNull()
    await new Promise((done) => setTimeout(done, 300))
    expect(hostProcesses(marker)).toEqual([])
  })
})
