// A trusted supervisor, with its own event loop, owns every checked process.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
export interface ChildResult {
  readonly ok: boolean
  readonly output: string
}
export const runPluginChild = (
  file: URL,
  args: ReadonlyArray<string>,
  options: {
    readonly timeout?: number
    readonly memory?: number
    readonly permissions?: ReadonlyArray<string>
    readonly networkFilter?: string
  } = {}
): Promise<ChildResult> =>
  new Promise((resolve) => {
    const supervisor = spawn(
      process.execPath,
      [
        "--max-old-space-size=64",
        fileURLToPath(new URL("./processSupervisor.ts", import.meta.url)),
        file.href,
        JSON.stringify({ args, options })
      ],
      { env: { LANG: "C", NODE_ENV: "production" }, stdio: ["ignore", "ignore", "ignore", "ipc"] }
    )
    let result: ChildResult = { ok: false, output: "Child supervisor failed" }
    supervisor.on("message", (message: { pluginChild?: number; result?: ChildResult }) => {
      if (message.pluginChild) process.send?.({ pluginChild: message.pluginChild })
      if (message.result) result = message.result
    })
    supervisor.once("error", () => resolve(result))
    supervisor.once("close", () => resolve(result))
  })
