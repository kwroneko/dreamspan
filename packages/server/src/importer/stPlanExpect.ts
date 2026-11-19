// A re-import preview the user confirmed (ARCHITECTURE.md §13 "Re-import preview"): what the
// import it starts is held to, file by file. `StImportPlans.confirm` makes it; `StImports`
// holds the run to it.
import { createHash } from "node:crypto"
import type { StPlanCounts, StPlanTarget } from "@dreamspan/shared/stReimportPlan.ts"

/**
 * A chat file's content hash: of the SHA-256 of each part, as the format worker took it of
 * the exact bytes it parsed. The import records it (`StImportFinishChat.sha256`); the check
 * and the confirmed import compare it.
 */
export const stPartsHash = (partHashes: ReadonlyArray<string>) =>
  createHash("sha256").update(partHashes.join("")).digest("hex")

/**
 * What the check and the confirmed import compare a chat file by: the SHA-256 of its bytes,
 * fed part by part, so it doesn't depend on where the parts fall (a browser and the server
 * cut a file differently). The import's record keeps `stPartsHash`, as before.
 */
export const stBytesHash = () => createHash("sha256")

/** A chat file the check read, which goes into a chat already here. */
export interface StPlanExpectFile {
  readonly path: string
  readonly target: StPlanTarget
  /** The chat it goes into. */
  readonly chatId: string
  /** Its own record (imported before), else null: a new branch of `parentPath`'s chat. */
  readonly recordId: string | null
  readonly parentPath: string | null
  /** Of the bytes the check read (`stBytesHash`). */
  readonly sha256: string
  /** What the check showed: the import's write of the file is refused unless it does the same. */
  readonly counts: StPlanCounts
  readonly digest: string
  readonly keepsTip: boolean
  /**
   * An earlier file for the same chat is skipped, so what this one does was shown as unknown:
   * it's held to its stamp, not to the counts the check worked out with that file included.
   */
  readonly uncertain: boolean
}

export interface StPlanExpect {
  readonly planId: string
  /** The files the check read, by path. */
  readonly files: ReadonlyMap<string, StPlanExpectFile>
  /** Every chat file the check listed, with its size: one it didn't list isn't imported. */
  readonly listed: ReadonlyMap<string, number>
  /** Each chat's stamp when the check read it (`stImportPlanStamp.ts`). */
  readonly stamps: ReadonlyMap<string, string>
  /** The files the user skipped. */
  readonly skip: ReadonlySet<string>
}
