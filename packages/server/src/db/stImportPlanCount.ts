// What the ST import's matcher did with one batch of a chat file, in the re-import preview's
// terms (ARCHITECTURE.md §13 "Re-import preview"): its counts, the changed messages for the
// detail list, and a digest of every message's outcome. One classifier for both callers: the
// preview's dry run (`StImportPlanBatch`) and the confirmed import's write
// (`StImportCommitChat`), which refuses, rolling back, unless its digest is the preview's.
import { createHash } from "node:crypto"
import { PLAN_TEXT_CHARS, type StPlanCounts, StPlanMessage } from "@dreamspan/shared/stReimportPlan.ts"
import type { PlaceEvent, StPlacedMessage } from "./stImportPlace.ts"

/** The start of a message's text for a detail row, on one line. */
const excerpt = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > PLAN_TEXT_CHARS ? `${line.slice(0, PLAN_TEXT_CHARS - 1)}…` : line
}

export const emptyCounts = (): { -readonly [K in keyof StPlanCounts]: number } => ({
  unchanged: 0,
  newMessages: 0,
  newSwipes: 0,
  selected: 0,
  kept: 0,
  branches: 0
})

const DIGEST_ZERO = "0".repeat(64)

/**
 * A counter for one batch: `observe` is `placeStMessages`' callback. `digest` folds this
 * batch's outcomes, one per message and each with its index in the file, into the file's
 * digest so far (`digestIn`, "" for its first batch), so equal digests mean every message was
 * placed alike, however the file was cut into parts and batches.
 */
export const planCounter = (
  messages: ReadonlyArray<StPlacedMessage>,
  firstIndex: number,
  detailLimit: number,
  digestIn: string
) => {
  const counts = emptyCounts()
  const details: Array<StPlanMessage> = []
  const outcomes: Array<string> = []
  let changed = 0
  const observe = (event: PlaceEvent) => {
    const message = messages[event.index]!
    let change: StPlanMessage["change"] | null
    let kept: StPlanMessage["kept"] = null
    if (event.outcome === "new") {
      counts.newMessages++
      if (event.branchFrom) counts.branches++
      change = event.branchFrom ? "branch" : "new"
    } else {
      kept =
        event.deleted || event.placeholder
          ? "deleted"
          : event.differs
            ? event.hiddenDiffers
              ? "hidden"
              : "choice"
            : null
      counts.newSwipes += event.addedVersions
      if (event.selected) counts.selected++
      if (kept !== null) counts.kept++
      change = event.addedVersions > 0 ? "swipes" : event.selected ? "selected" : kept !== null ? "kept" : null
      if (change === null) counts.unchanged++
    }
    outcomes.push(`${firstIndex + event.index}:${change ?? "same"}:${event.addedVersions}:${kept ?? ""}`)
    if (change === null) return
    changed++
    if (details.length >= detailLimit) return
    const chosen = message.selected < message.versions.length ? message.selected : 0
    details.push(
      new StPlanMessage({
        index: firstIndex + event.index,
        change,
        swipes: event.addedVersions,
        kept,
        user: message.user,
        text: excerpt(message.versions[chosen]!.content)
      })
    )
  }
  return {
    observe,
    counts,
    details,
    changed: () => changed,
    digest: () => {
      const folded = Buffer.from(digestIn === "" ? DIGEST_ZERO : digestIn, "hex")
      for (const outcome of outcomes) {
        const one = createHash("sha256").update(outcome).digest()
        for (let i = 0; i < folded.length; i++) folded[i] = folded[i]! ^ one[i]!
      }
      return folded.toString("hex")
    }
  }
}

/** A file's digest before its first batch. */
export const emptyDigest = ""

/** Two batches' or files' counts added. */
export const addCounts = (into: { -readonly [K in keyof StPlanCounts]: number }, add: StPlanCounts) => {
  for (const key of Object.keys(add) as Array<keyof StPlanCounts>) into[key] += add[key]
}

export const sameCounts = (a: StPlanCounts, b: StPlanCounts) =>
  (Object.keys(a) as Array<keyof StPlanCounts>).every((key) => a[key] === b[key])
