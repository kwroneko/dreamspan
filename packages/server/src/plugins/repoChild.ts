import { readFile, writeFile, lstat } from "node:fs/promises"
import { join } from "node:path"
import {
  repoInfo,
  repoVersions,
  snapshot,
  saveFiles,
  repoLog,
  repoDiff,
  checkoutCommit,
  confined,
  pluginFolder,
  commitFiles
} from "./repo.ts"
import { authorRepo, createAuthorRepo } from "./authorRepo.ts"
import type { RepoRequest } from "./repoTask.ts"
const [dataDir, folder] = process.argv.slice(2) as [string, string]
try {
  const request = JSON.parse(await readFile(join(folder, "request.json"), "utf8")) as RepoRequest
  const repo = pluginFolder(dataDir, request.owner, request.id)
  let result: unknown = null
  if (request.op === "authorCreate")
    result = await createAuthorRepo(dataDir, request.owner, request.id, request.files, request.key)
  else if (request.op === "save")
    result = await saveFiles(dataDir, request.owner, request.id, request.files, request.initial, request.message)
  else {
    await confined(dataDir, repo)
    switch (request.op) {
      case "author":
        result = await authorRepo(dataDir, request.owner, request.id, request.request)
        break
      case "verify":
        result = await snapshot(dataDir, request.owner, request.id, request.commit, undefined, false, request.approved)
        if (request.approved) {
          const build = await confined(
            dataDir,
            join(dataDir, "plugins/.builds", request.owner || "instance", request.id, request.commit)
          )
          for (const [path, bytes] of await commitFiles(repo, request.commit)) {
            await confined(dataDir, join(build, path, ".."))
            const file = join(build, path),
              info = await lstat(file)
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              info.nlink !== 1 ||
              info.size !== bytes.length ||
              !Buffer.from(bytes).equals(await readFile(file))
            )
              throw new Error("Approved build source changed")
          }
        }
        break
      case "info":
        result = await repoInfo(repo, request.selected)
        break
      case "versions":
        result = await repoVersions(repo, request.extra)
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
