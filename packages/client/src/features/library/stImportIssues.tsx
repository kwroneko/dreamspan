// An ST import report's "Warnings and errors" (ARCHITECTURE.md §13): the same issue on many
// files is one entry, said once, with how many files it's on and every one of them listed
// under it, each a link to the chat it went into. Errors come first, then warnings, each the
// rarest first, so a one-off isn't buried under one that's on every chat. Nothing is left out:
// what the report couldn't hold is said, with why.
import type { StImportJobDetail, StIssue } from "@dreamspan/shared/stImportApi.ts"
import { Link } from "@tanstack/react-router"
import { Badge, Card, CardHeader, Disclosure } from "../../ui/Surface.tsx"
import { Button } from "../../ui/Button.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { copy } from "../chat/copy.ts"

const TONES = { info: "neutral", warning: "warning", error: "danger" } as const
const RANK = { error: 0, warning: 1, info: 2 } as const

interface IssueGroup {
  readonly level: StIssue["level"]
  readonly code: string
  readonly message: string
  readonly items: ReadonlyArray<StIssue>
}

/** The issues as entries: one per level, code and message, errors first, then the rarest first. */
const groupIssues = (issues: ReadonlyArray<StIssue>): Array<IssueGroup> => {
  const groups = new Map<string, { level: StIssue["level"]; code: string; message: string; items: Array<StIssue> }>()
  for (const issue of issues) {
    const key = JSON.stringify([issue.level, issue.code, issue.message])
    const group = groups.get(key) ?? { level: issue.level, code: issue.code, message: issue.message, items: [] }
    group.items.push(issue)
    groups.set(key, group)
  }
  return [...groups.values()].sort(
    (a, b) => RANK[a.level] - RANK[b.level] || a.items.length - b.items.length || a.message.localeCompare(b.message)
  )
}

const isChat = (path: string) => path.endsWith(".jsonl")
const files = (count: number, items: ReadonlyArray<StIssue>) => {
  const noun = items.every((item) => isChat(item.path)) ? "chat" : "file"
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** One file of an entry: its path, a link to its chat when it went into one, and what's particular to it. */
function IssueItem({ issue }: { issue: StIssue }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      {issue.chatId === undefined ? (
        <span className="min-w-0 font-mono text-xs text-muted [overflow-wrap:anywhere]">{issue.path}</span>
      ) : (
        <Tooltip label="Opens the chat affected by this issue.">
          <Link
            to="/chats/$chatId"
            params={{ chatId: issue.chatId }}
            className="min-w-0 font-mono text-xs text-accent underline-offset-4 [overflow-wrap:anywhere] hover:underline"
          >
            {issue.path}
          </Link>
        </Tooltip>
      )}
      {issue.detail && <span className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">{issue.detail}</span>}
    </li>
  )
}

function IssueEntry({ group }: { group: IssueGroup }) {
  return (
    <li aria-label={`${group.level}: ${group.message}`} className="min-w-0 py-3 first:pt-0 last:pb-0">
      <Disclosure
        hint="Shows or hides the files affected by this issue."
        lazy
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-left [overflow-wrap:anywhere]">
            <Badge tone={TONES[group.level]}>{group.level}</Badge>
            <span>{group.message}</span>
            <span className="text-muted">{files(group.items.length, group.items)}</span>
          </span>
        }
      >
        <ul aria-label={`Files: ${group.message}`} className="flex flex-col gap-2">
          {group.items.map((issue, index) => (
            <IssueItem key={`${issue.path}\n${index}`} issue={issue} />
          ))}
        </ul>
      </Disclosure>
    </li>
  )
}

/** Include transfer/job failures as errors without repeating a matching report issue. */
export const reportIssues = (detail: StImportJobDetail): ReadonlyArray<StIssue> => {
  const issues = [...(detail.report?.issues ?? [])]
  for (const failure of detail.notSent) {
    if (
      !issues.some(
        (issue) => issue.path === failure.path && issue.level === "error" && issue.message === failure.message
      )
    )
      issues.push({ ...failure, level: "error", code: "st.not_sent" })
  }
  if (detail.job.error && !issues.some((issue) => issue.message === detail.job.error))
    issues.push({ path: detail.job.source, level: "error", code: "st.failed", message: detail.job.error })
  return issues
}

/** The entire report, including collapsed groups and pending decisions. */
const logText = (detail: StImportJobDetail) => {
  const { job, report } = detail
  return [
    `${job.status} · ${new Date(job.startedAt).toISOString()} · ${job.source}`,
    `Duration: ${Math.max(0, (job.finishedAt ?? job.updatedAt) - job.startedAt)} ms`,
    ...Object.entries(job.counts).map(
      ([kind, count]) =>
        `${kind}: ${count.added} added, ${count.updated} updated, ${count.unchanged} unchanged, ${count.skipped} skipped, ${count.failed} failed`
    ),
    ...(report
      ? [
          `${report.messages} messages, ${report.summaries} summaries, ${report.greetingOnly} greeting-only chats`,
          ...report.unsupported.map((item) => `${item.what}: ${item.count} unsupported`),
          ...report.links.map((choice) => `${choice.title}: ${choice.reason} (${choice.path})`),
          ...report.hiddenRuns.map(
            (run) =>
              `${run.title}: ${run.hidden} messages hidden from the start; ${run.summaryCovers === true ? "covered by its summary" : run.summaryCovers === false ? "not fully covered by its summary" : "no summary"}`
          )
        ]
      : []),
    ...groupIssues(reportIssues(detail)).flatMap((group) => [
      `${group.level}: ${group.message} (${group.items.length})`,
      ...group.items.map(
        (issue) =>
          `  ${issue.path}${issue.detail ? `: ${issue.detail}` : ""}${issue.chatId ? ` (${new URL(`/chats/${issue.chatId}`, location.origin).href})` : ""}`
      )
    ]),
    ...(report?.dropped ? [`${report.dropped} more issues or decisions could not fit in the report.`] : [])
  ].join("\n")
}

export function ImportLog({ detail }: { detail: StImportJobDetail }) {
  const groups = groupIssues(reportIssues(detail))
  return (
    <Card>
      <CardHeader
        title="Warnings and errors"
        actions={
          <Button hint="Copies the whole import report as text." onClick={() => void copy(logText(detail), "Log")}>
            Copy log
          </Button>
        }
      />
      {groups.length ? (
        <ul aria-label="Warnings and errors" className="flex flex-col divide-y divide-border">
          {groups.map((group) => (
            <IssueEntry key={JSON.stringify([group.level, group.code, group.message])} group={group} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No warnings or errors.</p>
      )}
      {!!detail.report?.dropped && (
        <p className="mt-3 text-sm text-muted">
          {detail.report.dropped} more issues or decisions could not fit in the report.
        </p>
      )}
    </Card>
  )
}
