// A stock SillyTavern in a throwaway container, for the differential harness (DESIGN §1.2).
//
// It shares the host's network namespace so that it can reach the mock endpoint on loopback,
// and listens on 127.0.0.1 only, on a random port. Its config and data directories are fresh
// directories under `root`, never an existing ST install. It runs as the calling user, so
// everything it writes can be removed without privileges.
//
// Only containers this harness created are ever removed: by exact name, or, for those left
// behind by a run that was killed, by our label when the process that made them is gone.
// The label names the process by PID namespace and PID, so a run in another namespace
// (a sandbox, a dev container) never takes a live run of ours for an orphan.
import { execFileSync, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, readlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

export const ST_VERSION = "1.19.0"
export const ST_IMAGE =
  "ghcr.io/sillytavern/sillytavern@sha256:eef27ff0c7961f1a2f488400f581f48ff38f8b910c5d3b8d389138d71791bb14"

const LABEL = "rp-harness.st-diff.owner"
const NAME_PREFIX = "rp-st-diff-"
const PID_NAMESPACE = readlinkSync("/proc/self/ns/pid")

export interface StContainer {
  readonly name: string
  readonly url: string
  /** The host path of ST's `default-user` directory. */
  readonly userDir: string
}

const docker = (args: ReadonlyArray<string>) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))
      )
    })
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Removes containers left by earlier runs of this harness whose process has exited. A
 * container must match all of: a name starting with our prefix and our label (both as
 * Docker filters, which it ANDs, and checked again here), a label value of our own shape
 * naming this PID namespace, and an owner process that's gone.
 */
export const removeOrphans = () => {
  const rows = docker([
    "ps",
    "-a",
    "--filter",
    `name=^${NAME_PREFIX}`,
    "--filter",
    `label=${LABEL}`,
    "--format",
    `{{.ID}} {{.Names}} {{.Label "${LABEL}"}}`
  ])
  for (const row of rows.split("\n").filter(Boolean)) {
    const [id, name = "", owner = ""] = row.split(" ")
    const match = /^(pid:\[\d+\])\/(\d+)$/.exec(owner)
    if (!id || !name.startsWith(NAME_PREFIX) || !match || match[1] !== PID_NAMESPACE) continue
    if (!alive(Number(match[2]))) spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" })
  }
}

// Whitelist mode with loopback only, no accounts, nothing fetched or launched at startup.
const config = (port: number) => `dataRoot: ./data
listen: true
listenAddress:
  ipv4: 127.0.0.1
  ipv6: '::1'
protocol:
  ipv4: true
  ipv6: false
port: ${port}
browserLaunch:
  enabled: false
whitelistMode: true
enableForwardedWhitelist: false
whitelist:
  - 127.0.0.1
whitelistDockerHosts: false
basicAuthMode: false
enableUserAccounts: false
skipContentCheck: false
enableDownloadableTokenizers: false
backups:
  chat:
    enabled: false
extensions:
  enabled: true
  autoUpdate: false
  models:
    autoDownload: false
logging:
  enableAccessLog: false
`

/**
 * Starts ST and waits until it serves its page. `track` gets the function that removes the
 * container before the container exists, so an interruption during startup removes it too.
 */
export const startSt = async (
  root: string,
  track: (stop: () => void) => void,
  timeoutMs = 180_000
): Promise<StContainer> => {
  const port = await freePort()
  const configDir = join(root, "config")
  const dataDir = join(root, "data")
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(configDir, "config.yaml"), config(port))

  const name = `${NAME_PREFIX}${process.pid}-${randomBytes(3).toString("hex")}`
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`
  const logs = () => {
    const result = spawnSync("docker", ["logs", "--tail", "60", name], { encoding: "utf8" })
    return `${result.stdout}${result.stderr}`
  }
  const stop = () => {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" })
  }
  track(stop)
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${LABEL}=${PID_NAMESPACE}/${process.pid}`,
    "--network",
    "host",
    "--user",
    user,
    "-v",
    `${configDir}:/home/node/app/config`,
    "-v",
    `${dataDir}:/home/node/app/data`,
    ST_IMAGE,
    "--port",
    String(port),
    "--listenAddressIPv4",
    "127.0.0.1"
  ])
  const container = { name, url: `http://127.0.0.1:${port}`, userDir: join(dataDir, "default-user") }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" }).stdout.trim()
    if (state !== "true") {
      const output = logs()
      stop()
      throw new Error(`SillyTavern exited during startup:\n${output}`)
    }
    try {
      const response = await fetch(container.url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return container
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const output = logs()
  stop()
  throw new Error(`SillyTavern didn't start within ${timeoutMs} ms:\n${output}`)
}
