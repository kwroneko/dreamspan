// npm run check: every static check and the fast tests, at once, so the run takes as long
// as its slowest step instead of their sum. One after another, the static checks alone took
// 520 s on the 48-core host at a load average of 50. The steps are package.json's own
// scripts, the typecheck split into its tsc projects. The tests' output streams as it comes;
// each other step's is printed when it ends. Fails if any step fails.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

const scripts: Record<string, string> = JSON.parse(readFileSync("package.json", "utf8")).scripts
const steps = [
  ...scripts.typecheck!.split(" && "),
  scripts.lint!,
  scripts["format:check"]!,
  scripts.knip!,
  scripts.test!
]
const live = scripts.test!

const run = (command: string) =>
  new Promise<boolean>((done) => {
    const started = performance.now()
    const child = spawn(command, { shell: true, stdio: ["ignore", command === live ? "inherit" : "pipe", "pipe"] })
    let output = ""
    child.stdout?.on("data", (chunk) => (output += chunk))
    child.stderr.on("data", (chunk) => (command === live ? process.stderr.write(chunk) : (output += chunk)))
    child.on("close", (code) => {
      const seconds = ((performance.now() - started) / 1000).toFixed(0)
      const status = code === 0 ? "ok" : `failed (${code})`
      process.stdout.write(`\n── ${command}: ${status}, ${seconds} s\n${code === 0 ? "" : output}`)
      done(code === 0)
    })
  })

const results = await Promise.all(steps.map(run))
const failed = steps.filter((_, i) => !results[i])
console.log(failed.length === 0 ? "\ncheck: all passed" : `\ncheck: failed: ${failed.join("; ")}`)
process.exitCode = failed.length === 0 ? 0 : 1
