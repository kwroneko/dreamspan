// Folders other accounts share with this one (spec/FILES-AND-ENVIRONMENT.md §1.4), as the Files
// routes, the file tools and commands see them at /files/Shared/<owner>/<folder>: the one place
// that says whether a share still names its folder and what each is called, so they all agree.
// A share here is an accepted one (`file_shares`; invitations live apart until accepted), owned
// and granted by account id; only its owner's handle names the folder above it.
import type { Stats } from "node:fs"
import { statPath } from "./safePath.ts"
import { folderShareRefusal } from "./pluginCopies.ts"

/** What naming and the identity check need of a share. */
export interface ShareOfFolder {
  readonly ownerHandle: string
  /** The folder's path in its owner's Files (/files/…). */
  readonly path: string
  readonly inode: number | null
  /** The device the folder was on when shared: with the inode, the folder's identity. */
  readonly device: number | null
  /** Its birth time when the filesystem gave one: with inode and device, what makes a reused inode number another folder. */
  readonly birthMs: number | null
  /** The folder went to the bin: the share stays off until its owner shares it again. */
  readonly suspendedAt: number | null
}

/** The owner's segment under Shared: its handle, when that can be a path component; null otherwise. */
const ownerSegment = (handle: string) =>
  /^[A-Za-z0-9_.-]{1,64}$/.test(handle) && !/^\.+$/.test(handle) ? handle : null

/** A folder's birth time (statx btime), or null where the filesystem doesn't give one (Node then reports 0). */
export const birthOf = (info: Pick<Stats, "birthtimeMs">) => (info.birthtimeMs > 0 ? info.birthtimeMs : null)

/**
 * Whether a share's folder is the one it was shared as: a folder with the recorded inode and
 * device (and birth time, when one was recorded: a deleted and recreated folder can get the same
 * inode number back, but not the same birth time), not in the bin since. A share with no identity
 * recorded never resolves. Shares of the
 * whole Files, or of anything holding or inside the server plugins' working copies, never
 * resolve either (`folderShareRefusal`). An unavailable share keeps its name (`shareMountNames`)
 * but is mounted nowhere.
 */
export const isSharedFolder = (
  share: Pick<ShareOfFolder, "inode" | "device" | "birthMs" | "suspendedAt">,
  segments: ReadonlyArray<string>,
  info: Stats | null
) =>
  info !== null &&
  info.isDirectory() &&
  share.suspendedAt === null &&
  share.inode !== null &&
  share.device !== null &&
  share.inode === info.ino &&
  share.device === info.dev &&
  (share.birthMs === null || share.birthMs === birthOf(info)) &&
  folderShareRefusal(segments) === null

/**
 * Each share's name under Shared/<owner>, in the given (path) order: its folder's own name, " (2)"
 * and on for a second of the same name, and never a name the grantee's own Files already hold at
 * Shared/<owner>/<name>. An owner whose segment is taken there by something other than a folder
 * keeps its place, and that owner's shares get no name (null).
 */
export const shareMountNames = async <S extends ShareOfFolder>(
  granteeRoot: string,
  shares: ReadonlyArray<S>
): Promise<ReadonlyArray<{ readonly share: S; readonly owner: string; readonly name: string } | null>> => {
  const taken = new Map<string, Set<string>>()
  const ownerFree = new Map<string, boolean>()
  const out: Array<{ share: S; owner: string; name: string } | null> = []
  for (const share of shares) {
    const owner = ownerSegment(share.ownerHandle)
    const own = share.path.slice(share.path.lastIndexOf("/") + 1)
    if (owner === null || own === "" || own === "." || own === "..") {
      out.push(null)
      continue
    }
    if (!ownerFree.has(owner)) {
      const info = await statPath(granteeRoot, ["Shared", owner]).catch(() => null)
      ownerFree.set(owner, info === null || info.isDirectory())
    }
    if (!ownerFree.get(owner)) {
      out.push(null)
      continue
    }
    const names = taken.get(owner) ?? new Set<string>()
    taken.set(owner, names)
    const ownTaken = async (name: string) =>
      (await statPath(granteeRoot, ["Shared", owner, name]).catch(() => null)) !== null
    let name = own
    for (let n = 2; names.has(name) || (await ownTaken(name)); n++) name = `${own} (${n})`
    names.add(name)
    out.push({ share, owner, name })
  }
  return out
}
