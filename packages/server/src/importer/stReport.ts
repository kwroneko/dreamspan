// The report of an ST folder import (ARCHITECTURE.md §13), as it accumulates: counts per kind,
// what the user must act on (errors and warnings, never details: nobody reads those), the
// hidden-run offers and the link choices, each bounded. Nothing a user needs lives only here.
import { type ImportReport, shownText } from "@rp/shared/importReport.ts"
import { StCount, type StHiddenRun, StImportReport, StIssue, type StLinkChoice } from "@rp/shared/stImportApi.ts"

const MAX_ISSUES = 500
const MAX_OFFERS = 2000

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
  private dropped = 0

  count(kind: string, outcome: Outcome) {
    const counter = this.counts.get(kind) ?? { added: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
    counter[outcome]++
    this.counts.set(kind, counter)
  }

  /** Infos aren't kept: a detail is shown where it applies, or not at all. */
  issue(path: string, level: StIssue["level"], code: string, message: string) {
    if (level === "info") return
    if (this.issues.length >= MAX_ISSUES) this.dropped++
    else this.issues.push(new StIssue({ path: shownText(path), level, code, message }))
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
    return new StImportReport({
      counts: Object.fromEntries([...this.counts].map(([kind, counter]) => [kind, new StCount(counter)])),
      messages: this.messages,
      summaries: this.summaries,
      greetingOnly: this.greetingOnly,
      unsupported: [...this.unsupported].map(([what, count]) => ({ what, count })),
      hiddenRuns: [...this.hiddenRuns.values()],
      links: [...this.links.values()],
      issues: issues.slice(0, MAX_ISSUES),
      dropped: this.dropped + Math.max(0, issues.length - MAX_ISSUES)
    })
  }
}
