// The report of an ST folder import (ARCHITECTURE.md §13), as it accumulates: counts per kind,
// what the user must act on (errors and warnings, never details: nobody reads those), the
// hidden-run offers and the link choices, each bounded. Nothing a user needs lives only here.
// Every issue is kept, up to a bound no real folder reaches (a few per file); the client shows
// the same issue on many files as one entry listing them all.
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { type ImportReport } from "@dreamspan/shared/importReport.ts"
import { StCount, type StHiddenRun, StImportReport, StIssue, type StLinkChoice } from "@dreamspan/shared/stImportApi.ts"

/** Issues a report keeps: one or two per file for a folder of ten thousand. */
const MAX_ISSUES = 20_000
const MAX_OFFERS = 2000

/** Checkpoints retain advisories for recovery; running imports expose only real errors. */
export const visibleReport = (report: StImportReport, running: boolean): StImportReport =>
  running
    ? new StImportReport({
        ...report,
        issues: report.issues.filter((issue) => issue.level === "error"),
        unsupported: [],
        links: [],
        hiddenRuns: [],
        dropped: 0
      })
    : report

type Outcome = "added" | "updated" | "unchanged" | "skipped" | "failed"

export class Report {
  selectedPreset: StIssue | null = null
  private readonly counts = new Map<string, Record<Outcome, number>>()
  messages = 0
  summaries = 0
  greetingOnly = 0
  readonly unsupported = new Map<string, number>()
  readonly hiddenRuns = new Map<string, StHiddenRun>()
  readonly links = new Map<string, StLinkChoice>()
  private readonly issues: Array<StIssue> = []
  /** The chat each chat file went into, which its issues link to. */
  private readonly chats = new Map<string, ChatId>()
  private dropped = 0

  count(kind: string, outcome: Outcome) {
    const counter = this.counts.get(kind) ?? { added: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
    counter[outcome]++
    this.counts.set(kind, counter)
  }

  /** Infos aren't kept: a detail is shown where it applies, or not at all. `detail`: what's particular to this file. */
  issue(path: string, level: StIssue["level"], code: string, message: string, detail?: string) {
    if (level === "info") return
    if (this.issues.length >= MAX_ISSUES) this.dropped++
    else this.issues.push(new StIssue({ path, level, code, message, ...(detail === undefined ? {} : { detail }) }))
  }

  /** The chat a chat file went into: its issues link there. */
  chat(path: string, chatId: ChatId) {
    this.chats.set(path, chatId)
  }

  /** A file's own report, its errors only: its warnings say what the import chose, and the entry shows it. */
  file(path: string, report: ImportReport) {
    for (const issue of report.issues) {
      if (issue.level === "error") this.issue(path, issue.level, issue.code, issue.message)
    }
  }

  offer(run: StHiddenRun) {
    if (this.hiddenRuns.size >= MAX_OFFERS && !this.hiddenRuns.has(run.chatId)) this.dropped++
    else this.hiddenRuns.set(run.chatId, run)
  }

  choose(choice: StLinkChoice) {
    if (this.links.size >= MAX_OFFERS && !this.links.has(choice.path)) this.dropped++
    else this.links.set(choice.path, choice)
  }

  /** `more`: issues known only once the folder is in, measured again on each read. */
  build(more: ReadonlyArray<StIssue> = []) {
    const issues = [...this.issues, ...(this.selectedPreset?.level === "warning" ? [this.selectedPreset] : []), ...more]
    const linked = issues.slice(0, MAX_ISSUES).map((issue) => {
      const chatId = issue.chatId ?? this.chats.get(issue.path)
      return chatId === undefined || issue.chatId !== undefined ? issue : new StIssue({ ...issue, chatId })
    })
    return new StImportReport({
      counts: Object.fromEntries([...this.counts].map(([kind, counter]) => [kind, new StCount(counter)])),
      messages: this.messages,
      summaries: this.summaries,
      greetingOnly: this.greetingOnly,
      unsupported: [...this.unsupported].map(([what, count]) => ({ what, count })),
      hiddenRuns: [...this.hiddenRuns.values()],
      links: [...this.links.values()],
      issues: linked,
      dropped: this.dropped + Math.max(0, issues.length - MAX_ISSUES)
    })
  }
}
