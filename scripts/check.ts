// npm run check: every static check and the fast tests, at once, so the run takes as long
// as its slowest step instead of their sum. One after another, the static checks alone took
// 520 s on the 48-core host at a load average of 50. The steps are package.json's own
// scripts, the typecheck split into its tsc projects. The tests' output streams as it comes;
// each other step prints a line when it ends. At the end, the output of every failed step
// other than the tests is printed again, then the names of the failed steps. Fails if any
// step fails.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

const scripts: Record<string, string> = JSON.parse(readFileSync("package.json", "utf8")).scripts
const steps = [
  ...scripts.typecheck!.split(" && ").map((command) => ({ name: `typecheck: ${command}`, command })),
  ...["lint", "format:check", "knip", "test"].map((name) => ({ name, command: scripts[name]! }))
]
const live = "test"

interface Result {
  readonly name: string
  readonly ok: boolean
  readonly output: string
}

const run = ({ name, command }: (typeof steps)[number]) =>
  new Promise<Result>((done) => {
    const started = performance.now()
    const child = spawn(command, {
      shell: true,
      // Native worker-bundle setup uses rolldown too; avoid huge-page compaction here
      // as well as in the bounded product children (plugins/processSupervisor.ts).
      env: { ...process.env, MIMALLOC_ALLOW_THP: "0" },
      stdio: ["ignore", name === live ? "inherit" : "pipe", "pipe"]
    })
    let output = ""
    child.stdout?.on("data", (chunk) => (output += chunk))
    child.stderr.on("data", (chunk) => (name === live ? process.stderr.write(chunk) : (output += chunk)))
    child.on("close", (code, signal) => {
      const seconds = ((performance.now() - started) / 1000).toFixed(0)
      const ok = code === 0
      process.stdout.write(`\n── ${name}: ${ok ? "ok" : `failed (${code ?? signal})`}, ${seconds} s\n`)
      done({ name, ok, output })
    })
  })

const results = await Promise.all(steps.map(run))
const failed = results.filter((result) => !result.ok)
for (const { name, output } of failed) {
  if (name !== live) process.stdout.write(`\n── ${name}: failed\n${output}`)
}
console.log(
  failed.length === 0 ? "\ncheck: all passed" : `\ncheck: failed: ${failed.map((result) => result.name).join(", ")}`
)
process.exitCode = failed.length === 0 ? 0 : 1
