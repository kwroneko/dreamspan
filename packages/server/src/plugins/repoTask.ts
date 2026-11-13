// Git object parsing also belongs in a bounded child: compressed objects are untrusted input.
import { randomUUID } from "node:crypto"
import { readFile, writeFile, rm, lstat } from "node:fs/promises"
import { join } from "node:path"
import { confined, limits, validPath } from "./repo.ts"
import { runPluginChild } from "./process.ts"
export type RepoRequest =
  | {
      readonly op: "save"
      readonly owner: string
      readonly id: string
      readonly files: Readonly<Record<string, string>>
      readonly initial: boolean
      readonly message: string
    }
  | { readonly op: "log"; readonly owner: string; readonly id: string }
  | {
      readonly op: "diff"
      readonly owner: string
      readonly id: string
      readonly before: string
      readonly after: string
    }
  | { readonly op: "checkout"; readonly owner: string; readonly id: string; readonly commit: string }
export const repoTask = async <A>(dataDir: string, request: RepoRequest): Promise<A> => {
  if (request.op === "save") {
    const entries = Object.entries(request.files)
    if (entries.length > limits.files) throw new Error("Plugin size limit exceeded")
    let size = 0
    for (const [path, content] of entries) {
      validPath(path)
      const bytes = Buffer.byteLength(content)
      size += bytes
      if (bytes > limits.file || size > limits.bytes) throw new Error("Plugin size limit exceeded")
    }
  }
  const folder = join(dataDir, "plugins/.ops", randomUUID())
  await confined(dataDir, folder, true)
  try {
    await writeFile(join(folder, "request.json"), JSON.stringify(request), { flag: "wx", mode: 0o600 })
    const child = await runPluginChild(new URL("./repoChild.ts", import.meta.url), [dataDir, folder], {
      timeout: 30_000,
      memory: 256
    })
    if (!child.ok) throw new Error("Plugin repository operation failed")
    const response = join(folder, "response.json"),
      info = await lstat(response)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new Error("Invalid repository response")
    return JSON.parse(await readFile(response, "utf8")) as A
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
