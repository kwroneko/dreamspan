import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { snapshot, saveFiles, repoLog, repoDiff, checkoutCommit, confined, pluginFolder } from "./repo.ts"
import type { RepoRequest } from "./repoTask.ts"
const [dataDir, folder] = process.argv.slice(2) as [string, string]
try {
  const request = JSON.parse(await readFile(join(folder, "request.json"), "utf8")) as RepoRequest
  const repo = pluginFolder(dataDir, request.owner, request.id)
  let result: unknown = null
  if (request.op === "save")
    result = await saveFiles(dataDir, request.owner, request.id, request.files, request.initial, request.message)
  else {
    await confined(dataDir, repo)
    switch (request.op) {
      case "verify":
        result = await snapshot(dataDir, request.owner, request.id, request.commit)
        break
      case "log":
        result = await repoLog(repo)
        break
      case "diff":
        result = await repoDiff(repo, request.before, request.after)
        break
      case "checkout":
        await checkoutCommit(dataDir, request.owner, request.id, request.commit)
        break
    }
  }
  await writeFile(join(folder, "response.json"), JSON.stringify(result), { flag: "wx", mode: 0o600 })
} catch {
  process.exitCode = 1
}
