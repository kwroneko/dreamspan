// The workshop's working folder on the host (spec/FILES-AND-ENVIRONMENT.md §2.1): a chosen path
// checked to be a folder of the account's Files, with its inode, and a stored one found again:
// by its path while that's a folder, else through the app's own moves, else (a rename or move by
// a command) by its inode with its name or parent kept. Otherwise it's reported as not found and
// the caller starts at the top of Files.
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

/** A folder moved or renamed in the app (`files.folderMoves`): where the path went. */
export interface FolderMove {
  readonly from: string
  readonly to: string
}

/** `path` after the app's own moves, oldest first; null when none applies to it. */
export const pathAfterMoves = (path: string, moves: ReadonlyArray<FolderMove>): string | null => {
  let now = path
  for (const move of moves)
    if (now === move.from || now.startsWith(`${move.from}/`)) now = `${move.to}${now.slice(move.from.length)}`
  return now === path ? null : now
}

/**
 * Where a stored working folder is now; null when it's gone, or when what was found can't be
 * told apart from an unrelated folder (§1 "Paths are the names"):
 * 1. its path, when that's still a folder: a folder deleted and made again at the same path, or
 *    replaced by a clone, is still the one meant;
 * 2. else where the app's own moves took that path, when the folder there has the stored inode;
 * 3. else (a rename or move made by a command) by its inode, but only a folder that kept its
 *    name, or was renamed inside the same (non-top) parent folder: inode numbers are reused,
 *    and a folder with another name elsewhere may be an unrelated one.
 */
export const locateFolder = async (
  root: string,
  stored: { readonly path: string; readonly inode: number | null },
  moves: ReadonlyArray<FolderMove> = []
): Promise<string | null> => {
  let segments: ReadonlyArray<string>
  try {
    segments = resolveFilesPath(stored.path, FILES_TOP).segments
  } catch {
    return null
  }
  if (segments.length === 0) return FILES_TOP
  const info = await statPath(root, segments).catch(() => null)
  if (info?.isDirectory()) return `${FILES_TOP}/${segments.join("/")}`
  if (stored.inode === null) return null
  const moved = pathAfterMoves(`${FILES_TOP}/${segments.join("/")}`, moves)
  if (moved !== null) {
    try {
      const at = resolveFilesPath(moved, FILES_TOP).segments
      const there = await statPath(root, at).catch(() => null)
      if (there?.isDirectory() && there.ino === stored.inode) return `${FILES_TOP}/${at.join("/")}`
    } catch {
      // A recorded move to a path that can't be read now: fall through to the search.
    }
  }
  const name = segments.at(-1)!
  const parentName = segments.at(-2) ?? null
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
      if (entry.ino === stored.inode) {
        // Renamed in the same folder (not the top, where every folder shares the parent), or
        // moved keeping its name; anything else may be an unrelated folder that got the number.
        const sameParent = parentName !== null && below.at(-1) === parentName
        return entry.name === name || sameParent ? `${FILES_TOP}/${at.join("/")}` : null
      }
      queue.push(at)
    }
  }
  return null
}
