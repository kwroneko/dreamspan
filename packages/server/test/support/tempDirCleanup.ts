// Shared with the environment loader, where Vitest's test hooks are unavailable.
import { rmSync } from "node:fs"

type TempGlobal = { rpTestTempDirs?: Array<string> }

export const trackTempDir = (dir: string) => {
  const made = ((globalThis as TempGlobal).rpTestTempDirs ??= [])
  made.push(dir)
}

/** Removes only explicitly owned directories; safe to call again from the environment. */
export const cleanupTempDirs = (global: object) => {
  for (const dir of (global as TempGlobal).rpTestTempDirs?.splice(0) ?? [])
    rmSync(dir, { recursive: true, force: true })
}
