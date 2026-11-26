import { execFile, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export const git = (cwd: string, args: ReadonlyArray<string>, timeout = 5_000) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout,
        killSignal: "SIGKILL",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
        windowsHide: true
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trimEnd()))
    ).stdin?.end()
  })

export type RunNpm = (cwd: string, command: "ci" | "build") => Promise<void>

export const runNpm: RunNpm = (cwd, command) =>
  new Promise<void>((resolve, reject) => {
    const cli = process.env.npm_execpath
    const useNode = cli !== undefined && /(?:^|[/\\])npm-cli\.js$/.test(cli)
    const windows = process.platform === "win32"
    const args = command === "ci" ? ["ci"] : ["run", "build"]
    // The Windows shell sees only the fixed npm.cmd command and fixed arguments.
    const child = spawn(useNode ? process.execPath : windows ? "npm.cmd" : "npm", useNode ? [cli, ...args] : args, {
      cwd,
      shell: !useNode && windows,
      stdio: "ignore",
      windowsHide: true
    })
    child.once("error", reject)
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("npm failed"))))
  })

/** Keep the generated files needed by the running server if a rebuild fails partway. */
export const backUpBuild = async (root: string) => {
  const backup = await mkdtemp(join(tmpdir(), "dreamspan-update-"))
  const outputs = ["packages/client/dist", "packages/server/dist/workers"]
  const existed = new Set<string>()
  const discard = () => rm(backup, { recursive: true, force: true }).catch(() => {})
  try {
    for (const output of outputs) {
      const present = await stat(join(root, output)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false
          throw error
        }
      )
      if (!present) continue
      await cp(join(root, output), join(backup, output), { recursive: true })
      existed.add(output)
    }
  } catch (error) {
    await discard()
    throw error
  }
  return {
    discard,
    restore: async () => {
      for (const output of outputs) {
        const path = join(root, output)
        await rm(path, { recursive: true, force: true })
        if (existed.has(output)) {
          await mkdir(dirname(path), { recursive: true })
          await cp(join(backup, output), path, { recursive: true })
        }
      }
    }
  }
}
