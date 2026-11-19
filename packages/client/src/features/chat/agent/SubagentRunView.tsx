// A subagent's own run in the run inspector (spec/SUBAGENTS.md §7), opened from its row's Inspect:
// who started it and how it ended, its instructions and task (its whole context: it never saw the
// chat), the tools it was offered as frozen, every request after the first with what each added
// and the model's answer, and its requests' usage and cost. Read only: a subagent's steps have no
// Edit or Resume from here (a later milestone resumes inside it).
import type { ChatId, VersionId } from "@dreamspan/shared/chat.ts"
import type { InspectorUsage } from "@dreamspan/shared/inspectorApi.ts"
import { Link } from "@tanstack/react-router"
import { type ComponentType, useMemo } from "react"
import { AsyncView } from "../../../actions.tsx"
import { AppClient } from "../../../rpc.ts"
import { CenterHeaderContent } from "../../../ui/CenterHeader.tsx"
import { Card, CardHeader } from "../../../ui/Surface.tsx"
import { Tooltip } from "../../../ui/Tooltip.tsx"
import { useTitle } from "../../shell.tsx"
import { Steps, Tools } from "./RunSteps.tsx"
import { subagentFacts } from "./SubagentPanel.tsx"

const ended = { running: "Working", waiting: "Waiting for you", done: "Done", stopped: "Stopped", failed: "Failed" }

export function SubagentRunView({
  chatId,
  versionId,
  rolloutId,
  usage: Usage
}: {
  chatId: ChatId
  versionId: VersionId
  rolloutId: string
  usage: ComponentType<{ requests: ReadonlyArray<InspectorUsage> }>
}) {
  useTitle("Subagent")
  const atom = useMemo(() => AppClient.query("GetSubagentRun", { versionId, rolloutId }), [versionId, rolloutId])
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <CenterHeaderContent>
          <h1 className="text-lg font-semibold">A subagent's run</h1>
        </CenterHeaderContent>
      </header>
      <AsyncView atom={atom} loading="Loading the subagent…">
        {(run) => (
          <div className="flex flex-col gap-4" data-subagent-run={run.row.handle}>
            <Tooltip label="Returns to the request of the reply that started this subagent.">
              <Link
                to="/chats/$chatId/context/$versionId"
                params={{ chatId, versionId }}
                className="text-sm text-muted hover:text-text"
              >
                ← Back to the reply's request
              </Link>
            </Tooltip>
            <Card>
              <CardHeader
                title={`Subagent · ${run.row.typeLabel}${run.row.name ? ` · ${run.row.name}` : ""}`}
                description={`${ended[run.row.status]} · ${subagentFacts(run.row)}`}
                about="A helper the assistant started inside this reply. It saw only its instructions and task, never the chat, and could use only the assistant's read tools. Its cost counts toward the reply."
              />
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted">Handle</dt>
                <dd className="font-mono [overflow-wrap:anywhere]">{run.row.handle}</dd>
                <dt className="text-muted">Model</dt>
                <dd className="[overflow-wrap:anywhere]">The reply's own: {run.row.model}</dd>
                {run.error && (
                  <>
                    <dt className="text-muted">Error</dt>
                    <dd className="text-danger [overflow-wrap:anywhere]">{run.error}</dd>
                  </>
                )}
              </dl>
            </Card>
            <section aria-label="Its context" className="flex flex-col gap-2">
              <h2 className="text-base font-semibold">Its context</h2>
              <Card>
                <CardHeader title="Subagent instructions" />
                <pre className="max-h-96 overflow-auto font-mono text-xs whitespace-pre-wrap text-text [overflow-wrap:anywhere]">
                  {run.instructions}
                </pre>
              </Card>
              <Card>
                <CardHeader title="Task" />
                <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{run.row.task}</p>
              </Card>
            </section>
            {run.tools.length > 0 && <Tools tools={run.tools} entries={run.entries} />}
            {run.entries.length > 0 && (
              <Steps
                requests={run.requests}
                entries={run.entries}
                cut={[]}
                editing={null}
                first="Every request after the first is its context above, then everything listed before it here."
              />
            )}
            <Card>
              <CardHeader title="Usage" about="Its requests, which the reply's cost includes." />
              <Usage requests={run.requests} />
            </Card>
          </div>
        )}
      </AsyncView>
    </div>
  )
}
