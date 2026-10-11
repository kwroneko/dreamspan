// One line of sizes, so growth is visible per commit (spec/WORKFLOW.md §3): code lines in
// sources and tests (blank and comment lines not counted), comment lines in both, and doc lines.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "" && !file.startsWith("spikes/"))

const counts = { source: 0, test: 0, comments: 0, docs: 0 }
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n")
  if (file.endsWith(".md")) {
    counts.docs += lines.filter((line) => line.trim() !== "").length
  } else if (/^packages\/[^/]+\/.*\.(ts|tsx|css)$/.test(file) || /^scripts\/.*\.ts$/.test(file)) {
    for (const line of lines) {
      const text = line.trim()
      if (text === "") continue
      if (/^(\/\/|\/\*|\*)/.test(text)) counts.comments++
      else if (/^packages\/[^/]+\/test\//.test(file)) counts.test++
      else counts.source++
    }
  }
}
console.log(
  Object.entries(counts)
    .map(([name, n]) => `${name} ${n}`)
    .join("  ")
)
