// A tool call waiting for the user (spec/WORKSHOP.md §3.4), under its step: what it will do as the
// server describes it from the call's real arguments (never the model's own words), the fields an
// edit changes, and the answers. Allow lets this one call run; Allow in this workshop also lets the
// assistant do this kind of thing here without asking; Decline tells it not to, with a note if the
// user writes one. The answer names the call's arguments' digest, so it holds for this call only.
import { storyScopeText } from "@rp/shared/branchNaming.ts"
import type { ApprovalAnswer } from "@rp/shared/workshopApi.ts"
import { ReplyExtrasContext } from "../replyExtras.ts"
import { useContext, useState } from "react"
import { ErrorAlert, useAction } from "../../../actions.tsx"
import { Button } from "../../../ui/Button.tsx"
import { Field, Textarea } from "../../../ui/Field.tsx"
import { RevisionComparison, RevisionDiff } from "../../../ui/RevisionDiff.tsx"
import { Alert } from "../../../ui/Surface.tsx"
import { Tooltip } from "../../../ui/Tooltip.tsx"
import type { StepActionProps } from "./stepActions.ts"

/** What the app shows when it stopped while the call may have been running. */
const UNCERTAIN_TEXT =
  "The app stopped while this was running. It may already have happened: check before allowing it again."

export function ApprovalPanel({ step }: StepActionProps) {
  const approval = step.status === "waiting" ? step.approval : undefined
  const action = useAction()
  const replyExtras = useContext(ReplyExtrasContext)
  const [answering, setAnswering] = useState<ApprovalAnswer | null>(null)
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState("")
  if (!approval) return null
  const answer = async (choice: ApprovalAnswer) => {
    setAnswering(choice)
    const trimmed = note.trim()
    await action.run(
      (client) =>
        client("AnswerToolApproval", {
          rolloutId: approval.rolloutId,
          toolCallId: approval.toolCallId,
          digest: approval.digest,
          answer: choice,
          ...replyExtras(),
          ...(choice === "deny" && trimmed !== "" ? { note: trimmed } : {})
        }),
      // Allowing it in this workshop changes what the chip shows.
      choice === "allow_chat" ? ["workshop-capabilities"] : []
    )
    setAnswering(null)
  }
  const busy = answering !== null
  return (
    <div
      data-approval={approval.toolCallId}
      role="group"
      aria-label={`The assistant asks: ${approval.title}`}
      className="ml-5 flex flex-col gap-2 rounded-md border border-warning/50 bg-surface p-3 text-sm"
    >
      <div className="flex flex-col gap-0.5">
        <p className="font-medium [overflow-wrap:anywhere]">{approval.title}</p>
        <p className="text-xs text-muted [overflow-wrap:anywhere]">Asks first: {approval.capabilityLabel}</p>
      </div>
      {approval.uncertain && <Alert tone="warning">{UNCERTAIN_TEXT}</Alert>}
      {approval.storyScope && (
        <p className="text-xs font-medium [overflow-wrap:anywhere]">{storyScopeText(approval.storyScope)}</p>
      )}
      {approval.rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" aria-label="What it will write">
          {approval.rows
            .filter((row) => !approval.storyScope || !["Scope", "Story position"].includes(row.label))
            .map((row) => (
              <div key={row.label} className="contents">
                <dt className="max-w-28 text-muted [overflow-wrap:anywhere]">{row.label}</dt>
                <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {row.value.length <= 4000 ? (
                    row.value
                  ) : (
                    <details>
                      <Tooltip label="Opens the full text the assistant will use for this field.">
                        <summary className="cursor-pointer">
                          {row.value.slice(0, 240)}… (cut short; show all {row.value.length.toLocaleString()}{" "}
                          characters)
                        </summary>
                      </Tooltip>
                      <div className="mt-1 max-h-60 overflow-y-auto">{row.value}</div>
                    </details>
                  )}
                </dd>
              </div>
            ))}
        </dl>
      )}
      {approval.changes?.map((change) => (
        <div key={change.field} className="flex flex-col gap-1" data-approval-change={change.field}>
          <p className="text-xs font-medium [overflow-wrap:anywhere]">{change.field}</p>
          {Math.max(change.before.length, change.after.length) > 4000 || approval.changes!.length > 32 ? (
            <RevisionComparison
              label={
                approval.changes!.length > 32
                  ? `Full changes to ${change.field}`
                  : `Full change (${change.before.length.toLocaleString()} → ${change.after.length.toLocaleString()} characters)`
              }
              before={change.before}
              after={change.after}
            />
          ) : (
            <RevisionDiff before={change.before} after={change.after} unifiedLabel={`Changes to ${change.field}`} />
          )}
        </div>
      ))}
      {noting && (
        <Field label="Note for the assistant" description="Sent with Decline, so it knows why. Optional.">
          <Textarea value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.target.value)} />
        </Field>
      )}
      <ErrorAlert error={action.error} title="Your answer wasn’t taken" />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          pending={answering === "allow"}
          disabled={busy}
          hint="Lets the assistant do this once."
          onClick={() => void answer("allow")}
        >
          Allow
        </Button>
        <Button
          pending={answering === "allow_chat"}
          disabled={busy}
          hint={`Lets it do this kind of thing here without asking again (${approval.capabilityLabel}).`}
          onClick={() => void answer("allow_chat")}
        >
          Allow in this workshop
        </Button>
        <Button
          pending={answering === "deny"}
          disabled={busy}
          hint="Tells the assistant not to. Nothing is changed."
          onClick={() => void answer("deny")}
        >
          Decline
        </Button>
        {!noting && (
          <Button
            variant="ghost"
            disabled={busy}
            hint="Adds a note the assistant gets with Decline, saying why or what to do instead."
            onClick={() => setNoting(true)}
          >
            Add a note
          </Button>
        )}
      </div>
    </div>
  )
}
