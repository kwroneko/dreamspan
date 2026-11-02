// An ST import report's "Needs your attention" (ARCHITECTURE.md §13): the same issue on many
// files is one entry, said once, with how many files it's on and every one of them listed
// under it, each a link to the chat it went into. Errors come first, then warnings, each the
// rarest first, so a one-off isn't buried under one that's on every chat. Nothing is left out:
// what the report couldn't hold is said, with why.
import type { StImportReport, StIssue } from "@rp/shared/stImportApi.ts"
import { Link } from "@tanstack/react-router"
import { Badge, Card, CardHeader, Disclosure } from "../../ui/Surface.tsx"

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
        <Link
          to="/chats/$chatId"
          params={{ chatId: issue.chatId }}
          className="min-w-0 font-mono text-xs text-accent underline-offset-4 [overflow-wrap:anywhere] hover:underline"
        >
          {issue.path}
        </Link>
      )}
      {issue.detail && <span className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">{issue.detail}</span>}
    </li>
  )
}

function IssueEntry({ group }: { group: IssueGroup }) {
  const count = group.items.length
  return (
    <li
      aria-label={`${group.level}: ${group.message}`}
      className="flex min-w-0 flex-col gap-1.5 py-3 first:pt-0 last:pb-0"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <Badge tone={TONES[group.level]}>{group.level}</Badge>
        {count > 1 && <span className="text-sm font-medium">{files(count, group.items)}</span>}
      </div>
      <p className="min-w-0 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{group.message}</p>
      {count === 1 ? (
        <ul className="flex flex-col gap-1.5">
          <IssueItem issue={group.items[0]!} />
        </ul>
      ) : (
        <Disclosure lazy title={`Show the ${files(count, group.items)}`}>
          <ul aria-label={`Files: ${group.message}`} className="-mt-2 flex flex-col gap-1.5">
            {group.items.map((issue, index) => (
              <IssueItem key={`${issue.path}\n${index}`} issue={issue} />
            ))}
          </ul>
        </Disclosure>
      )}
    </li>
  )
}

export function NeedsAttention({ report }: { report: StImportReport }) {
  if (report.issues.length === 0 && report.dropped === 0) return null
  const groups = groupIssues(report.issues)
  return (
    <Card>
      <CardHeader
        title="Needs your attention"
        description={
          groups.length > 1
            ? `${report.issues.length} in all, in ${groups.length} kinds: errors first, then the rarest first.`
            : undefined
        }
      />
      <ul aria-label="Needs your attention" className="flex flex-col divide-y divide-border">
        {groups.map((group) => (
          <IssueEntry key={JSON.stringify([group.level, group.code, group.message])} group={group} />
        ))}
      </ul>
      {report.dropped > 0 && (
        <p className="mt-3 text-sm text-muted">
          {report.dropped} more issues, hidden runs or chats to link weren't kept: a report holds at most 20,000 issues
          and 2,000 of each of the others. Import the folder again once these are dealt with to see them.
        </p>
      )}
    </Card>
  )
}
