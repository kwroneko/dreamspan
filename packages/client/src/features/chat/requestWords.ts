// What a request to a model was for, and how it ended, in words (owner, 2026-11-02): the
// stored `purpose` and `status` are identifiers, so every screen that shows a request (the
// summary's Details, the request inspector) says them through these.
import type { RequestPurpose, RequestStatus } from "@rp/shared/usage.ts"

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * What the request was for. `about` names what it worked on when the screen knows it: the
 * messages a summary covers, or how many summaries a condensation joins.
 */
export const requestPurposeText = (
  purpose: RequestPurpose,
  about: { readonly from?: number; readonly to?: number; readonly summaries?: number } = {}
): string => {
  switch (purpose) {
    case "generation":
      return "Writing a reply"
    case "summarize":
      return about.from === undefined || about.to === undefined
        ? "Summarizing messages"
        : about.from === about.to
          ? `Summarizing message ${about.from}`
          : `Summarizing messages ${about.from}–${about.to}`
    case "condense":
      return about.summaries === undefined || about.summaries === 0
        ? "Condensing summaries"
        : `Condensing ${plural(about.summaries, "summary", "summaries")}`
    case "decision":
      return "Asking the decision model"
    case "workshop":
      return "Writing a workshop reply"
    case "idle_job":
      return "A background job"
    case "edit":
      return "Rewriting text"
    case "test":
      return "Testing the connection"
  }
}

const statusWords: Record<RequestStatus, string> = {
  running: "running",
  complete: "finished",
  failed: "failed",
  aborted: "stopped",
  interrupted: "interrupted"
}

/** How the request ended, or that it's still running: "finished". */
export const requestStatusText = (status: RequestStatus): string => statusWords[status]
