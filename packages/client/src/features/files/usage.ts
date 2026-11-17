// The Files quota in the file manager (spec/FILES-AND-ENVIRONMENT.md §1.2): the usage line under
// the toolbar, and the check before an upload that it fits in the room left.
import { formatByteSize } from "@rp/shared/byteSize.ts"
import type { FilesUsage } from "@rp/shared/filesQuotaApi.ts"

/** Past this share of the quota the usage line turns to a warning. */
export const WARN_SHARE = 0.9

type Usage = Pick<FilesUsage, "usedBytes" | "quotaBytes" | "over">

/** The room left; none once the account is over its quota. */
export const freeBytes = (usage: Usage) => (usage.over ? 0 : Math.max(0, usage.quotaBytes - usage.usedBytes))

/** "1.2 GB of 10 GB used", and whether it's near or over the quota. */
export const usageLine = (usage: Usage & Pick<FilesUsage, "partial">) => ({
  text: `${usage.partial ? "More than " : ""}${formatByteSize(usage.usedBytes)} of ${formatByteSize(usage.quotaBytes)} used`,
  warn: usage.over || usage.usedBytes >= usage.quotaBytes * WARN_SHARE
})

/** What a batch that doesn't fit is told: "These files need 2.1 GB; 800 MB is free." */
export const noRoomMessage = (needed: number, free: number, count: number) =>
  `${count === 1 ? "This file needs" : "These files need"} ${formatByteSize(needed)}; ${
    free === 0 ? "nothing" : formatByteSize(free)
  } is free.`

/** Null when `needed` bytes fit, else the message saying they don't. */
export const roomProblem = (needed: number, count: number, usage: Usage) => {
  const free = freeBytes(usage)
  return needed > free ? noRoomMessage(needed, free, count) : null
}
