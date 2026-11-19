// Plugin working copies in the account's Files (spec/FILES-AND-ENVIRONMENT.md §5.3), the files
// host's `pluginWorkingCopies` entry: /files/Plugins/<id> (an instance plugin's at
// /files/Plugins/Server/<id>; plugin ids are lower case, so the two never meet). Every access goes
// through the no-follow walk (safePath.ts): the copy is in the tree commands change, so a link
// planted there is refused, never followed. The app never reads the copy's `.git`.
import { Effect } from "effect"
import type { User } from "@dreamspan/shared/domain.ts"
import type { PluginCopyTarget, PluginWorkingCopy } from "../agent/pluginWorkingCopies.ts"
import { FILES_MOUNT } from "./environment.ts"
import { listFolder, readRegularFile, removeFile, statPath, writeRegularFile } from "./safePath.ts"

/** The repository's limits (plugins/repo.ts `limits`), checked here first for a plain message. */
const LIMITS = { file: 512 * 1024, bytes: 8 * 1024 * 1024, files: 256, depth: 24 }
/** Left out of a commit from the copy: the agent's own Git and installed packages. */
const LEFT_OUT: ReadonlySet<string> = new Set([".git", "node_modules"])

const copySegments = (target: PluginCopyTarget) =>
  target.scope === "instance" ? ["Plugins", "Server", target.id] : ["Plugins", target.id]

const decode = (bytes: Uint8Array, path: string) => {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${path} isn't UTF-8 text. A plugin holds text files only.`)
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw new Error(`${path} isn't a text file. A plugin holds text files only.`)
  return text
}

export interface PluginCopyDeps {
  /** The account's Files on the host, made when missing. */
  readonly rootOf: (userId: string) => Promise<string>
  /** Keeps a file's content as a version (files/../agent/tools/files.ts `keepVersion`). */
  readonly keepVersion: (
    call: { readonly rolloutId: string; readonly toolCallId: string } | null,
    userId: string,
    path: string,
    content: { readonly bytes: Uint8Array; readonly inode: number | null },
    origin: string
  ) => Effect.Effect<string, unknown>
  /** Bytes written, for the quota until its next measurement. */
  readonly wrote?: (userId: string, bytes: number) => void
  readonly onChanged?: (userId: string, paths: ReadonlyArray<string>) => void
  /** Gives a new copy a `.git` of its own, made by a command in the sandbox; absent or failing: none. */
  readonly initGit?: (userId: string, folder: string) => Promise<void>
}

export const makePluginCopies = (deps: PluginCopyDeps): PluginWorkingCopy => {
  const where = (target: PluginCopyTarget) => `${FILES_MOUNT}/${copySegments(target).join("/")}`
  const attempt = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({
      try: f,
      catch: (error) => (error instanceof Error ? error : new Error("The working copy couldn't be read."))
    })

  const read = (actor: User, target: PluginCopyTarget) =>
    attempt(async () => {
      const root = await deps.rootOf(actor.id)
      const base = copySegments(target)
      if (!(await statPath(root, base).catch(() => null))?.isDirectory())
        throw new Error(`There's no working copy at ${where(target)}.`)
      const files: Record<string, string> = {}
      let count = 0
      let total = 0
      const visit = async (below: ReadonlyArray<string>): Promise<void> => {
        if (below.length > LIMITS.depth) throw new Error(`${where(target)} is nested too deep for a plugin.`)
        const listed = await listFolder(root, [...base, ...below], LIMITS.files * 4)
        if (listed.more) throw new Error(`${where(target)} has more files than a plugin can hold (${LIMITS.files}).`)
        for (const entry of listed.entries) {
          const path = [...below, entry.name].join("/")
          if (LEFT_OUT.has(entry.name) || entry.name.endsWith(".rp-tmp")) continue
          if (entry.kind === "folder") await visit([...below, entry.name])
          else if (entry.kind !== "file")
            throw new Error(`${path} is a link or a special file. A plugin holds regular text files only.`)
          else {
            if (++count > LIMITS.files) throw new Error(`A plugin holds at most ${LIMITS.files} files.`)
            if (entry.size > LIMITS.file) throw new Error(`${path} is larger than a plugin file can be (512 KiB).`)
            const { bytes } = await readRegularFile(root, [...base, ...below, entry.name], LIMITS.file + 1)
            total += bytes.byteLength
            if (total > LIMITS.bytes) throw new Error("The working copy is larger than a plugin can be (8 MiB).")
            files[path] = decode(bytes, path)
          }
        }
      }
      await visit([])
      return files
    })

  const sync: PluginWorkingCopy["sync"] = ({ actor, target, before, after, call }) =>
    Effect.gen(function* () {
      const root = yield* attempt(() => deps.rootOf(actor.id))
      const base = copySegments(target)
      const fresh = !(yield* attempt(() => statPath(root, base).catch(() => null)))?.isDirectory()
      const overwritten: Array<string> = []
      const changed: Array<string> = []
      let bytes = 0
      const current = (path: string) =>
        attempt(() =>
          readRegularFile(root, [...base, ...path.split("/")], LIMITS.file + 1).catch((error: unknown) =>
            (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : Promise.reject(error)
          )
        )
      /** The copy's own change is kept before the repository's content replaces it. */
      const keep = (path: string, found: { bytes: Buffer; info: { ino: number } }) =>
        Effect.gen(function* () {
          overwritten.push(path)
          yield* deps
            .keepVersion(
              call ?? null,
              actor.id,
              `${where(target)}/${path}`,
              { bytes: found.bytes, inode: found.info.ino },
              "agent"
            )
            .pipe(Effect.mapError(() => new Error(`The working copy's ${path} couldn't be kept as a version.`)))
        })
      for (const [path, text] of Object.entries(after)) {
        const found = yield* current(path)
        const next = Buffer.from(text, "utf8")
        if (found && !found.truncated && found.bytes.equals(next)) continue
        const was = before?.[path]
        if (found && (was === undefined || found.truncated || !found.bytes.equals(Buffer.from(was, "utf8"))))
          yield* keep(path, found)
        yield* attempt(() => writeRegularFile(root, [...base, ...path.split("/")], next, { createFolders: true }))
        bytes += next.byteLength
        changed.push(path)
      }
      for (const [path, was] of Object.entries(before ?? {})) {
        if (Object.hasOwn(after, path)) continue
        const found = yield* current(path)
        if (!found) continue
        if (found.truncated || !found.bytes.equals(Buffer.from(was, "utf8"))) yield* keep(path, found)
        yield* attempt(() => removeFile(root, [...base, ...path.split("/")]))
        changed.push(path)
      }
      if (bytes) deps.wrote?.(actor.id, bytes)
      if (changed.length)
        deps.onChanged?.(
          actor.id,
          changed.map((path) => `${where(target)}/${path}`)
        )
      // A new copy gets a .git of its own for the agent's commands (never read by the app).
      if (fresh && deps.initGit) {
        const folder = where(target)
        yield* Effect.promise(() => deps.initGit!(actor.id, folder).catch(() => undefined))
      }
      return { path: where(target), overwritten }
    })

  return { id: "files.pluginCopies", where, read, sync }
}
