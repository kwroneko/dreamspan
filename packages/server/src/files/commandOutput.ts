// A command's full output (spec/FILES-AND-ENVIRONMENT.md §5.1): the `bash` result shows a head
// and a tail; the app keeps the whole output, up to 16 MiB, so `bash_output` can page through it,
// and a background command's output is read from here as it runs. Files live outside every
// account's Files and outside the sandbox, at DATA_DIR/command-output/<userId>/<id>.log, and go
// after a day (at most 200 per account, oldest first). Main-thread async file I/O only.
import { randomBytes } from "node:crypto"
import { mkdir, open, readdir, rm, stat, truncate, type FileHandle } from "node:fs/promises"
import { join } from "node:path"

const OUTPUT_KEEP_BYTES = 16 * 2 ** 20
const KEEP_MS = 24 * 3600_000
const KEEP_PER_ACCOUNT = 200
const ID = /^cmd_[a-f0-9]{16}$/

export interface OutputSink {
  readonly id: string
  /** Appends what the command wrote, up to the kept size. */
  readonly write: (chunk: Buffer) => void
  /** Waits for the writes, then cuts what follows `bytes` (the sandbox's end line), and closes. */
  readonly end: (bytes: number) => Promise<void>
  /** Bytes kept so far. */
  readonly kept: () => number
}

export interface OutputPage {
  /** Lines `from` (1-based) to `from + lines.length - 1`. */
  readonly from: number
  readonly lines: ReadonlyArray<string>
  readonly totalLines: number
  readonly bytes: number
  /** The output was longer than what is kept. */
  readonly cut: boolean
}

export const makeCommandOutputs = (dataDir: string) => {
  const base = join(dataDir, "command-output")
  const folderOf = (userId: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Unexpected user id.")
    return join(base, userId)
  }
  const cutAt = new Map<string, boolean>()

  const open_ = async (userId: string): Promise<OutputSink> => {
    const folder = folderOf(userId)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const id = `cmd_${randomBytes(8).toString("hex")}`
    const path = join(folder, `${id}.log`)
    const file: FileHandle = await open(path, "wx", 0o600)
    let kept = 0
    let chain: Promise<unknown> = Promise.resolve()
    let cut = false
    void prune(userId)
    return {
      id,
      write: (chunk) => {
        const room = OUTPUT_KEEP_BYTES - kept
        if (room <= 0) {
          cut = true
          return
        }
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk
        if (part.length < chunk.length) cut = true
        kept += part.length
        const copy = Buffer.from(part)
        chain = chain.then(() => file.write(copy)).catch(() => undefined)
      },
      end: async (bytes) => {
        await chain
        await file.close().catch(() => undefined)
        if (bytes < kept) await truncate(path, bytes).catch(() => undefined)
        kept = Math.min(kept, bytes)
        cutAt.set(`${userId}/${id}`, cut || bytes > OUTPUT_KEEP_BYTES)
      },
      kept: () => kept
    }
  }

  /** Lines of a kept output, or null when there's none of that id for this account. */
  const page = async (userId: string, id: string, from: number, limit: number): Promise<OutputPage | null> => {
    if (!ID.test(id)) return null
    const path = join(folderOf(userId), `${id}.log`)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    const handle = await open(path, "r")
    try {
      const bytes = Buffer.alloc(Math.min(info.size, OUTPUT_KEEP_BYTES))
      await handle.read(bytes, 0, bytes.length, 0)
      const text = bytes.toString("utf8")
      const all = text === "" ? [] : text.replace(/\n$/, "").split("\n")
      const start = Math.max(1, from)
      return {
        from: start,
        lines: all.slice(start - 1, start - 1 + limit),
        totalLines: all.length,
        bytes: info.size,
        cut: cutAt.get(`${userId}/${id}`) ?? info.size >= OUTPUT_KEEP_BYTES
      }
    } finally {
      await handle.close()
    }
  }

  /** Bytes from `offset` of a kept output (what a running command wrote since the last read). */
  const since = async (userId: string, id: string, offset: number, maxBytes: number) => {
    if (!ID.test(id)) return null
    const path = join(folderOf(userId), `${id}.log`)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    const length = Math.max(0, Math.min(info.size - offset, maxBytes))
    if (length === 0) return { text: "", next: offset, size: info.size }
    const handle = await open(path, "r")
    try {
      const bytes = Buffer.alloc(length)
      const { bytesRead } = await handle.read(bytes, 0, length, offset)
      // Stop at the last whole line (or a whole UTF-8 sequence) unless it's all there is.
      let end = bytesRead
      const newline = bytes.subarray(0, bytesRead).lastIndexOf(10)
      if (newline >= 0 && offset + bytesRead < info.size) end = newline + 1
      return { text: bytes.subarray(0, end).toString("utf8"), next: offset + end, size: info.size }
    } finally {
      await handle.close()
    }
  }

  /** Outputs older than a day, and past the per-account count. */
  const prune = async (userId?: string) => {
    const accounts = userId ? [userId] : await readdir(base).catch(() => [] as Array<string>)
    let removed = 0
    for (const account of accounts) {
      const folder = folderOf(account)
      const names = (await readdir(folder).catch(() => [] as Array<string>)).filter((n) => n.endsWith(".log"))
      const dated = await Promise.all(
        names.map(async (name) => ({ name, at: (await stat(join(folder, name)).catch(() => null))?.mtimeMs ?? 0 }))
      )
      dated.sort((a, b) => b.at - a.at)
      for (const [index, entry] of dated.entries())
        if (index >= KEEP_PER_ACCOUNT || Date.now() - entry.at > KEEP_MS) {
          await rm(join(folder, entry.name), { force: true }).catch(() => undefined)
          removed++
        }
    }
    return removed
  }

  return { open: open_, page, since, prune }
}

export type CommandOutputs = ReturnType<typeof makeCommandOutputs>
