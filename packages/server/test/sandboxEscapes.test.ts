// Escape tests for the Linux command sandbox (spec/FILES-AND-ENVIRONMENT.md §3, §9 L0): a
// synthetic data folder (database, server secret, another account's files) beside one account's
// Files, and commands that try to reach it, write outside, reach private addresses, exhaust
// processes, memory and time, and leave processes behind. Skipped, saying why, where bubblewrap
// or unprivileged user namespaces aren't available.
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs"
import { rm, statfs } from "node:fs/promises"
import { createServer, request as httpRequest, type Server } from "node:http"
import { connect } from "node:net"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { deniedCalls, linuxBwrap, seccompFilter, sweepRunFolders } from "../src/sandbox/linuxBwrap.ts"
import { selectLimiter } from "../src/sandbox/cgroupLimits.ts"
import {
  ownAddresses,
  PROXY_MAX_CONNECTIONS,
  reachableAddresses,
  sandboxMayReach,
  sandboxNetworks,
  setPublicAddresses
} from "../src/sandbox/network.ts"
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
    // bubblewrap took its arguments from a descriptor: no host folder or end marker in them.
    expect(text).toMatch(/bwrap --args \d /)
    expect(text).not.toContain(data)
    expect(text).not.toContain("__rp_cwd_")
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
    // The host's own IPv6 address is refused however the literal is spelled.
    const own = ownAddresses({
      synthetic: [
        {
          address: "2606:4700:4700::1111",
          family: "IPv6",
          netmask: "",
          mac: "",
          internal: false,
          cidr: null,
          scopeid: 0
        }
      ]
    })
    for (const spelling of [
      "2606:4700:4700::1111",
      "2606:4700:4700:0:0:0:0:1111",
      "2606:4700:4700:0000::1111",
      "2606:4700:4700::1111".toUpperCase()
    ])
      expect(sandboxMayReach(spelling, own)).toBe(false)
    // A public name pointed at loopback (DNS rebinding) is refused; a mixed answer keeps the public one.
    expect(await reachableAddresses("rebind.example", async () => ["127.0.0.1"])).toEqual([])
    expect(await reachableAddresses("mixed.example", async () => ["10.0.0.1", "93.184.215.14"])).toEqual([
      "93.184.215.14"
    ])
    expect(await reachableAddresses("localhost", async () => ["93.184.215.14"])).toEqual([])
  })

  it("stops a fork bomb at its process limit and timeout", { tags: ["slow"] }, async () => {
    const started = Date.now()
    const result = await run("bomb() { bomb | bomb & }; bomb; sleep 2; echo survived", {
      limits: { timeoutMs: 8000, processes: 64, memoryBytes: 2 ** 30, fileBytes: 2 ** 30, openFiles: 256 }
    })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(result.exitCode === null || result.exitCode >= 0).toBe(true)
    // The host still forks.
    expect(execFileSync("/bin/sh", ["-c", "echo ok"], { encoding: "utf8" }).trim()).toBe("ok")
  })

  it("caps a process's memory", { tags: ["slow"] }, async () => {
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

  it("kills the command and everything it started at the timeout", { tags: ["slow"] }, async () => {
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

  it("leaves no process behind when the command ends, daemons included", { tags: ["slow"] }, async () => {
    const marker = `rp-leftover-${randomBytes(4).toString("hex")}`
    const result = await run(
      `(exec -a ${marker} sleep 300 &); setsid bash -c 'exec -a ${marker} sleep 300' & nohup bash -c 'exec -a ${marker} sleep 300' >/dev/null 2>&1 & disown -a; echo started`
    )
    expect(output(result)).toContain("started")
    await new Promise((done) => setTimeout(done, 300))
    expect(hostProcesses(marker)).toEqual([])
  })

  it("kills the process tree when the run is stopped", { tags: ["slow"] }, async () => {
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

// Review (review-sandbox1): further ways out that were tried, one test each.
sandboxed("the Linux sandbox, further attempts", () => {
  const small = { timeoutMs: 20_000, processes: 64, memoryBytes: 2 ** 30, fileBytes: 2 ** 30, openFiles: 256 }

  it("has no capabilities and no new privileges, and setuid programs don't change that", async () => {
    const result = await run(
      [
        "grep -E '^(CapEff|CapPrm|CapBnd|NoNewPrivs)' /proc/self/status",
        "sudo -n id -u 2>&1 | tail -1",
        "su -c 'id -u' root </dev/null 2>&1 | tail -1",
        "mkdir -p /tmp/m && mount -t tmpfs none /tmp/m 2>&1 && echo mounted",
        "id -u"
      ].join("; ")
    )
    const text = output(result)
    expect(text).toMatch(/^CapEff:\s+0+$/m)
    expect(text).toMatch(/^CapPrm:\s+0+$/m)
    expect(text).toMatch(/^CapBnd:\s+0+$/m)
    expect(text).toMatch(/^NoNewPrivs:\s+1$/m)
    expect(text).not.toMatch(/^0$/m)
    expect(text).not.toContain("mounted")
  })

  it.skipIf(process.arch !== "x64")(
    "refuses the kernel calls commands don't need (io_uring, keyrings, userfaultfd, bpf, mount)",
    async () => {
      const probe = [
        "import ctypes, sys",
        "libc = ctypes.CDLL(None, use_errno=True)",
        "for name, nr in (('io_uring_setup', 425), ('keyctl', 250), ('userfaultfd', 323), ('bpf', 321), ('perf_event_open', 298), ('fsopen', 430), ('unshare', 272)):",
        "    r = libc.syscall(nr, 0, 0, 0, 0, 0)",
        "    print(name, r, ctypes.get_errno())"
      ].join("\n")
      const result = await run(
        `grep '^Seccomp:' /proc/self/status; python3 -c '${probe.replace(/'/g, `'\\''`)}'; node -e 'console.log("node-ok")'`
      )
      const text = output(result)
      expect(text).toMatch(/^Seccomp:\s+2$/m)
      for (const name of ["io_uring_setup", "keyctl", "userfaultfd", "bpf", "perf_event_open", "fsopen", "unshare"])
        expect(text).toMatch(new RegExp(`^${name} -1 1$`, "m"))
      // Programs that try io_uring first fall back.
      expect(text).toContain("node-ok")
    }
  )

  it("sees no /sys, /var or Docker socket, only its own runtime folder, and inherits no descriptors", async () => {
    // Listing /proc/self/fd can include the directory handle used to enumerate it. Check
    // each entry after that handle is closed, in the same process that did the listing.
    const listFds = [
      "import os",
      'path = "/proc/self/fd"',
      "for fd in sorted(os.listdir(path)):",
      '    if os.path.lexists(os.path.join(path, fd)): print("fd=" + fd)'
    ].join("\n")
    const result = await run(
      [
        "ls /sys 2>&1 | head -1",
        "ls /var/run/docker.sock /run/docker.sock /var 2>&1",
        "ls /run",
        `python3 -c '${listFds}'`,
        "cat /dev/tty 2>&1 | head -1"
      ].join("; ")
    )
    const text = output(result)
    const lines = text.split("\n").map((line) => line.trim())
    expect(text).toContain("cannot access '/sys'")
    expect(text).toContain("cannot access '/var/run/docker.sock'")
    expect(text).toContain("cannot access '/var'")
    expect(lines).toContain("rp")
    expect(lines.filter((line) => line.startsWith("fd="))).toEqual(["fd=0", "fd=1", "fd=2"])
    // No controlling terminal to push input into (TIOCSTI): a new session without one.
    expect(text).toMatch(/No such device or address/)
  })

  it("can't hard-link a file from outside its writable folders into them", async () => {
    const result = await run("ln /etc/ld.so.cache /files/hl 2>&1; ln /run/rp/bridge.mjs /files/hl2 2>&1; true")
    expect(output(result)).toMatch(/Invalid cross-device link/)
    expect(existsSync(join(files, "hl"))).toBe(false)
    expect(existsSync(join(files, "hl2"))).toBe(false)
  })

  it("sizes the memory-backed folders, keeps /dev read-only and offers itself to the OOM killer first", async () => {
    const result = await run(
      [
        "{ head -c 3000000 /dev/zero > /tmp/fill; } 2>&1; ls -l /tmp/fill | awk '{print \"tmp=\" $5}'",
        "{ head -c 3000000 /dev/zero > /dev/shm/fill; } 2>&1; ls -l /dev/shm/fill | awk '{print \"shm=\" $5}'",
        "touch /dev/planted 2>/dev/null || echo dev-ro",
        "cat /proc/self/oom_score_adj"
      ].join("; "),
      { limits: { ...small, tmpBytes: 2 ** 21 } }
    )
    const text = output(result)
    const size = (name: string) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(text)?.[1] ?? Number.NaN)
    expect(size("tmp")).toBeLessThanOrEqual(2 ** 21)
    expect(size("shm")).toBeLessThanOrEqual(2 ** 21)
    expect(text).toContain("No space left on device")
    expect(text).toContain("dev-ro")
    expect(text).toMatch(/^1000$/m)
  })

  it(
    "doesn't start, or is stopped, when the disk the app shares goes below the reserve",
    { tags: ["slow"], timeout: 60_000 },
    async () => {
      const marker = `reserve-${randomBytes(4).toString("hex")}`
      const refused = await run(`echo x > ${marker}`, {
        limits: { ...small, reserve: { bytes: Number.MAX_SAFE_INTEGER, inodes: 0 } }
      })
      expect(refused.diskLow).toBe(true)
      expect(refused.exitCode).toBeNull()
      expect(existsSync(join(files, marker))).toBe(false)
      // Going below it mid-run: stopped during the sleep, so it never says it finished.
      const fs = await statfs(files)
      const free = fs.bavail * fs.bsize
      const stopped = await run(`head -c 157286400 /dev/urandom > ${marker}; sync; sleep 15; echo never`, {
        limits: { ...small, timeoutMs: 40_000, reserve: { bytes: free - 50 * 2 ** 20, inodes: 0 } }
      })
      await rm(join(files, marker), { force: true })
      expect(stopped.diskLow).toBe(true)
      expect(stopped.timedOut).toBe(false)
      expect(output(stopped)).not.toContain("never")
    }
  )

  it("refuses numeric, mapped and zero forms of loopback, and tunnels to ports other than HTTP and HTTPS", async () => {
    const proxied = await run(
      [
        `curl -sS -m 5 http://2130706433:${port}/ 2>&1; echo`,
        `curl -sS -m 5 http://0x7f.1:${port}/ 2>&1; echo`,
        `curl -sS -m 5 http://0177.0.0.1:${port}/ 2>&1; echo`,
        `curl -sS -m 5 http://0:${port}/ 2>&1; echo`,
        `curl -sS -m 5 'http://[::ffff:127.0.0.1]:${port}/' 2>&1; echo`,
        `curl -sS -m 5 'http://[64:ff9b::7f00:1]:${port}/' 2>&1; echo`,
        `curl -sS -m 5 http://localhost.:${port}/ 2>&1; echo`,
        `curl -sS -m 5 -p http://127.0.0.1:${port}/ 2>&1; echo`,
        // A Host header naming loopback changes nothing: the proxy dials the checked address.
        `curl -sS -m 5 -H 'Host: 127.0.0.1:${port}' http://127.0.0.1:${port}/ 2>&1; echo`,
        // SSH or SMTP through a tunnel to a public address: refused before dialling.
        "curl -sS -m 5 -p telnet://93.184.215.14:25 </dev/null 2>&1 | head -2; echo",
        "curl -sS -m 5 -p http://93.184.215.14:22/ 2>&1 | head -2; echo"
      ].join("; "),
      { network: "public" }
    )
    const text = output(proxied)
    expect(text).not.toContain(SECRET)
    expect(text).toContain("Only public internet addresses can be reached from commands.")
    expect(text.match(/CONNECT tunnel failed, response 403/g)?.length).toBe(3)
  })
})

const limiter = await selectLimiter()
if ("none" in limiter) console.warn(`sandboxEscapes: no cgroup limiter here, its tests are skipped: ${limiter.none}`)

describe.skipIf(skipReason !== null || "none" in limiter)("the Linux sandbox with a cgroup per command", () => {
  const capped = { timeoutMs: 30_000, processes: 64, memoryBytes: 2 ** 30, fileBytes: 4 * 2 ** 30, openFiles: 256 }

  it(
    "stops 1.5 GiB of shared mappings, memfds and processes together under a 1 GiB cap",
    { tags: ["slow"], timeout: 120_000 },
    async () => {
      // A shared anonymous mapping and a memfd aren't counted by `ulimit -d`; four processes of
      // 400 MiB each pass any per-process cap. The markers are built when printed.
      const shared = [
        "import mmap",
        "m = mmap.mmap(-1, 1536 << 20, mmap.MAP_SHARED | mmap.MAP_ANONYMOUS)",
        "for i in range(0, 1536 << 20, 4096): m[i] = 1",
        'print("SHARED" + "-OK")'
      ].join("\n")
      const memfd = [
        "import os",
        "fd = os.memfd_create('x')",
        "chunk = b'x' * (1 << 20)",
        "for _ in range(1536): os.write(fd, chunk)",
        'print("MEMFD" + "-OK")'
      ].join("\n")
      const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
      for (const [script, marker] of [
        [`python3 -c ${quote(shared)}`, "SHARED-OK"],
        [`python3 -c ${quote(memfd)}`, "MEMFD-OK"],
        [
          `for i in 1 2 3 4; do python3 -c 'import time; x = bytearray(400 << 20); time.sleep(4); print("EACH" + "-OK")' & done; wait; echo "ALL" "DONE"`,
          "EACH-OK"
        ]
      ] as const) {
        const result = await run(script, { limits: capped })
        expect(output(result)).not.toContain(marker)
        expect(result.exitCode).not.toBe(0)
        expect(result.memoryCapped).toBe(true)
      }
      // Below the cap, programs work.
      const fine = await run(
        `python3 -c ${quote(shared.replace(/1536/g, "256"))}; node -e 'const b = Buffer.alloc(256 * 2 ** 20); b.fill(1); console.log("SMALL" + "-OK")'`,
        { limits: capped }
      )
      expect(output(fine)).toContain("SHARED-OK")
      expect(output(fine)).toContain("SMALL-OK")
      expect(fine.memoryCapped).toBeUndefined()
    }
  )

  it("leaves $ in a command to bash inside the sandbox, never the host's wrapper", async () => {
    // systemd-run would otherwise expand ${NAME}, a whole-argument $NAME and $$ with the
    // host's values before bash sees the command.
    const result = await run(
      `printf '%s|' "\${HOME}" "$HOME" "\${UNSET:-x}" '$$' "$$" '\${HOME}' "\${XDG_RUNTIME_DIR:-none}"`
    )
    const [braced, plain, fallback, literal, pid, quoted, runtime] = output(result).split("|")
    expect([braced, plain, fallback, literal, quoted, runtime]).toEqual([
      "/home/user",
      "/home/user",
      "x",
      "$$",
      "${HOME}",
      "none"
    ])
    expect(pid).toMatch(/^\d+$/)
    expect(output(result)).not.toContain(homedir())
  }, 60_000)

  it("passes a wrapped program's arguments through unchanged", async () => {
    if ("none" in limiter) return
    const group = await limiter.open({ memoryBytes: 256 * 2 ** 20, processes: 32 })
    const args = ["${HOME}", "$HOME", "${UNSET:-x}", "$$", "a$$b", "$XDG_RUNTIME_DIR"]
    const start = group.wrap("/bin/sh", ["-c", "printf '%s\\n' \"$@\"", "probe", ...args])
    const text = execFileSync(start.file, start.args, { encoding: "utf8", timeout: 10_000, env: { ...group.env } })
    await group.finish()
    expect(text.trimEnd().split("\n")).toEqual(args)
  }, 30_000)

  it("caps processes for the whole command", async () => {
    const result = await run("for i in $(seq 1 100); do sleep 5 & done 2>&1 | head -1; wait; echo done", {
      limits: { ...capped, processes: 32 }
    })
    expect(output(result)).toMatch(/fork|Resource temporarily unavailable|retry/i)
  }, 60_000)
})

describe("the Linux sandbox's start and filters", () => {
  it("removes run folders only of servers that are gone", async () => {
    const root = tempDir("run-folders")
    // A process id that can't be running: above the kernel's largest.
    const dead = join(root, "dreamspan-sbx-99999999-abcdef")
    const mine = join(root, `dreamspan-sbx-${process.pid}-abcdef`)
    const unrelated = join(root, "dreamspan-sbx-something-else")
    for (const dir of [dead, mine, unrelated]) mkdirSync(join(dir, "rp"), { recursive: true })
    expect(await sweepRunFolders(root)).toBe(1)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(mine)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it("builds the seccomp filter for x86_64 and aarch64, and none elsewhere", () => {
    for (const [arch, audit, x32] of [
      ["x64", 0xc000003e, 1],
      ["arm64", 0xc00000b7, 0]
    ] as const) {
      const filter = seccompFilter(arch)!
      const calls = Object.values(deniedCalls(arch))
      expect(filter.length).toBe((4 + x32 + calls.length + 2) * 8)
      expect(filter.readUInt32LE(8 + 4)).toBe(audit)
      // Every refused call is compared once, and the last two instructions are allow, then EPERM.
      const compared = Array.from({ length: calls.length }, (_, i) => filter.readUInt32LE((4 + x32 + i) * 8 + 4))
      expect(compared).toEqual(calls)
      expect(filter.readUInt32LE(filter.length - 4)).toBe(0x00050001)
      expect(filter.readUInt32LE(filter.length - 12)).toBe(0x7fff0000)
    }
    expect(deniedCalls("arm64").mount).toBe(40)
    expect(deniedCalls("arm64").uselib).toBeUndefined()
    expect(seccompFilter("riscv64")).toBeNull()
  })
})

describe("the commands proxy", () => {
  /** One request through the proxy's socket: its status and body. Nothing leaves the host. */
  const through = (socketPath: string, options: { method: string; path: string }) =>
    new Promise<{ status: number; body: string }>((done, fail) => {
      const req = httpRequest({ socketPath, method: options.method, path: options.path }, (res) => {
        let body = ""
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
        res.on("end", () => done({ status: res.statusCode ?? 0, body }))
      })
      req.on("error", fail)
      req.end()
    })

  it("sends plain HTTP only to ports 80 and 443, as tunnels", async () => {
    const socketPath = join(tempDir("proxy-ports"), "p.sock")
    const proxy = await sandboxNetworks.get("public")!.open(socketPath)
    try {
      // A public address (a literal, so no lookup), on mail and SSH ports: refused before dialling.
      for (const port of [25, 22, 587, 6379, 8080]) {
        const answer = await through(socketPath, { method: "POST", path: `http://8.8.4.4:${port}/` })
        expect(answer.status).toBe(403)
        expect(answer.body).toContain("Commands can reach HTTPS (port 443) and HTTP (port 80) only.")
      }
    } finally {
      await proxy.close()
    }
  })

  it("refuses the server's own public addresses behind NAT", async () => {
    expect(sandboxMayReach("8.8.4.4")).toBe(true)
    const before = setPublicAddresses((address) => address === "8.8.4.4" || address === "2001:4860:4860::8844")
    const socketPath = join(tempDir("proxy-own"), "p.sock")
    const proxy = await sandboxNetworks.get("public")!.open(socketPath)
    try {
      expect(sandboxMayReach("8.8.4.4")).toBe(false)
      expect(sandboxMayReach("2001:4860:4860::8844")).toBe(false)
      expect(sandboxMayReach("8.8.8.8")).toBe(true)
      expect(await reachableAddresses("8.8.4.4")).toEqual([])
      const answer = await through(socketPath, { method: "GET", path: "http://8.8.4.4/" })
      expect(answer.status).toBe(403)
      expect(answer.body).toContain("Only public internet addresses can be reached from commands.")
    } finally {
      setPublicAddresses(before)
      await proxy.close()
    }
  })

  it("holds at most its connection cap open at once", async () => {
    const socketPath = join(tempDir("proxy"), "p.sock")
    const proxy = await sandboxNetworks.get("public")!.open(socketPath)
    try {
      const sockets = Array.from({ length: PROXY_MAX_CONNECTIONS + 20 }, () => connect(socketPath))
      let closed = 0
      for (const socket of sockets) {
        socket.on("error", () => undefined)
        socket.on("close", () => closed++)
      }
      await new Promise((done) => setTimeout(done, 1000))
      expect(closed).toBeGreaterThanOrEqual(20)
      for (const socket of sockets) socket.destroy()
    } finally {
      await proxy.close()
    }
  })
})

sandboxed("the Linux sandbox when the server dies", () => {
  it("leaves no command behind when the server is killed outright", { tags: ["slow"], timeout: 30_000 }, async () => {
    const marker = `rp-orphan-${randomBytes(4).toString("hex")}`
    const dir = tempDir("orphan")
    const script = join(dir, "server.ts")
    const command = `(exec -a ${marker} sleep 300) & setsid bash -c 'exec -a ${marker} sleep 300' & wait`
    writeFileSync(
      script,
      [
        `import { linuxBwrap } from ${JSON.stringify(join(import.meta.dirname, "../src/sandbox/linuxBwrap.ts"))}`,
        `void linuxBwrap.run(${JSON.stringify(spec(command, { limits: { ...spec("").limits, timeoutMs: 120_000 } }))}, new AbortController().signal)`,
        "setInterval(() => undefined, 1000)"
      ].join("\n")
    )
    // Its runtime folder is left behind by the kill, so it goes in this test's folder.
    const server = spawn(process.execPath, [script], {
      stdio: "ignore",
      cwd: import.meta.dirname,
      env: { ...process.env, DREAMSPAN_SANDBOX_RUNTIME: dir }
    })
    try {
      const deadline = Date.now() + 15_000
      while (hostProcesses(marker).length < 2 && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 100))
      expect(hostProcesses(marker).length).toBeGreaterThanOrEqual(2)
    } finally {
      server.kill("SIGKILL")
    }
    const deadline = Date.now() + 5000
    while (hostProcesses(marker).length > 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
    expect(hostProcesses(marker)).toEqual([])
  })
})
