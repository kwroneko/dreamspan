// The workshop's working folder on the host (spec/FILES-AND-ENVIRONMENT.md §2.1): a chosen path
// checked to be a folder of the account's Files, with its inode, and a stored one found again. A
// folder renamed or moved by a command is found by its inode on the next lookup; if the inode is
// gone too, it's reported as not found and the caller starts at the top of Files.
import { FILES_TOP } from "@dreamspan/shared/files.ts"
import { resolveFilesPath } from "./environment.ts"
import { FilePathRefused, listFolder, statPath } from "./safePath.ts"

/** How long a search by inode may take, and how many folders it reads at most. */
const FIND_BUDGET_MS = 1000
const FIND_MAX_FOLDERS = 20_000

/** The folder at `path` (a path under /files), with its inode; refused when it isn't a folder. */
export const folderAt = async (root: string, path: string) => {
  const { full, segments } = resolveFilesPath(path, FILES_TOP)
  const info = await statPath(root, segments).catch(() => null)
  if (!info?.isDirectory()) throw new FilePathRefused(`${full} isn't a folder of your files.`)
  return { path: full, inode: segments.length === 0 ? null : info.ino }
}

/** Where a stored working folder is now: at its path, else by its inode; null when it's gone. */
export const locateFolder = async (
  root: string,
  stored: { readonly path: string; readonly inode: number | null }
): Promise<string | null> => {
  let segments: ReadonlyArray<string>
  try {
    segments = resolveFilesPath(stored.path, FILES_TOP).segments
  } catch {
    return null
  }
  if (segments.length === 0) return FILES_TOP
  const info = await statPath(root, segments).catch(() => null)
  if (info?.isDirectory() && (stored.inode === null || info.ino === stored.inode))
    return `${FILES_TOP}/${segments.join("/")}`
  if (stored.inode === null) return null
  // Breadth first from the top, without following links, within a budget.
  const deadline = Date.now() + FIND_BUDGET_MS
  const queue: Array<ReadonlyArray<string>> = [[]]
  let read = 0
  while (queue.length && Date.now() < deadline && read < FIND_MAX_FOLDERS) {
    const below = queue.shift()!
    read++
    const listed = await listFolder(root, below, 5_000).catch(() => null)
    if (!listed) continue
    for (const entry of listed.entries) {
      if (entry.kind !== "folder") continue
      const at = [...below, entry.name]
      if (entry.ino === stored.inode) return `${FILES_TOP}/${at.join("/")}`
      queue.push(at)
    }
  }
  return null
}
