import process from "node:process"
import { fileURLToPath } from "node:url"
import { runNpm, setExitStatus } from "./child-process.mjs"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const env = { ...process.env, MIMALLOC_ALLOW_THP: "0" }

try {
  for (const workspace of ["@dreamspan/client", "@dreamspan/server"]) {
    const result = await runNpm(["run", "build", "-w", workspace], { cwd, env })
    if (result.code !== 0 || result.interrupted) {
      setExitStatus(result)
      break
    }
  }
} catch (error) {
  console.error("Could not run the Dreamspan build. Make sure Node.js and npm are installed.", error.message)
  process.exitCode = 1
}
