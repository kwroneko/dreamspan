// A tool call waiting for the user (spec/WORKSHOP.md §3.4), under its step: what it will do as the
// server describes it from the call's real arguments (never the model's own words), the fields an
// edit changes, and the answers. Allow lets this one call run; Allow in this workshop also lets the
// assistant do this kind of thing here without asking; Decline tells it not to, with a note if the
// user writes one. The answer names the call's arguments' digest, so it holds for this call only.
import { syncClientPlugins } from "../../../pluginLifecycle.ts"
import { useCaller } from "../../editor/caller.ts"
import { useDurableText } from "../../editor/durable.tsx"
import { StoryScope } from "../../workshop/StoryScope.tsx"
import type { ApprovalAnswer } from "@dreamspan/shared/workshopApi.ts"
import { useState } from "react"
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

/** An interrupted call to an MCP server (spec/MCP.md §8.3): what the app's record of it says. */
const rerunFacts = (rerun: NonNullable<NonNullable<StepActionProps["step"]["approval"]>["rerun"]>) => {
  if (rerun.sentAt === null) return "It was never sent."
  const at = new Date(rerun.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return rerun.status === "complete"
    ? `The app had sent it to ${rerun.connection} at ${at} and got an answer, but stopped before keeping it.`
    : `The app had sent it to ${rerun.connection} at ${at} and got no answer.`
}

export function ApprovalPanel({ step, version }: StepActionProps) {
  const approval = step.status === "waiting" ? step.approval : undefined
  return approval ? <WaitingApproval approval={approval} version={version} /> : null
}

function WaitingApproval({ approval, version }: { approval: Prompt; version: StepActionProps["version"] }) {
  const action = useAction()
  const call = useCaller()
  const [answering, setAnswering] = useState<ApprovalAnswer | null>(null)
  const [adding, setAdding] = useState(false)
  // The note is kept as typed (editor/durable.tsx), so it's there again after a reload.
  const durable = useDurableText(`approval-note:${approval.rolloutId}:${approval.toolCallId}`, "Note", "")
  const note = durable.text
  const noting = adding || note !== ""
  const answer = async (choice: ApprovalAnswer) => {
    setAnswering(choice)
    const trimmed = note.trim()
    const result = await action.run(
      (client) =>
        client("AnswerToolApproval", {
          rolloutId: approval.rolloutId,
          toolCallId: approval.toolCallId,
          digest: approval.digest,
          answer: choice,
          ...(choice === "deny" && trimmed !== "" ? { note: trimmed } : {})
        }),
      // Allowing it in this workshop changes what the chip shows.
      choice === "allow_chat" ? ["workshop-capabilities"] : []
    )
    setAnswering(null)
    // Sent with Decline, the note is the answer's; with another answer it goes to the bin.
    if (result.ok && note !== "") void (choice === "deny" ? durable.commit(async () => true) : durable.discard())
    if (result.ok && approval.plugin && choice === "allow") {
      // The approval reply precedes compilation/activation. Keep following this exact call
      // even if the completed steps fold and unmount this panel. Other tabs keep their reload notice.
      void (async () => {
        const until = Date.now() + 60000
        while (Date.now() < until) {
          const effects = await call((client) => client("ListVersionEffects", { versionId: version.id }))
          if (!effects.ok) return
          if (effects.value.some((e) => e.toolCallId === approval.toolCallId && e.kind === "plugin.enable")) {
            await syncClientPlugins()
            return
          }
          const steps = await call((client) => client("GetRolloutSteps", { versionId: version.id }))
          if (
            !steps.ok ||
            steps.value.some((s) => s.kind === "tool" && s.id === approval.toolCallId && s.status === "error")
          )
            return
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      })().catch(() => undefined)
    }
  }
  const busy = answering !== null
  const rerun = approval.rerun
  if (approval.restart)
    return (
      <RestartPanel
        approval={approval}
        restart={approval.restart}
        answer={answer}
        answering={answering}
        error={action.error}
      />
    )
  return (
    <div
      data-approval={approval.toolCallId}
      role="group"
      aria-label={`The assistant asks: ${approval.title}`}
      className="ml-5 flex flex-col gap-2 rounded-md border border-warning/50 bg-surface p-3 text-sm"
    >
      <div className="flex flex-col gap-0.5">
        <p className="font-medium [overflow-wrap:anywhere]">{approval.title}</p>
        <p className="text-xs text-muted [overflow-wrap:anywhere]">
          {rerun
            ? `Interrupted call to ${rerun.connection} (${rerun.host})`
            : `Asks first: ${approval.capabilityLabel}`}
        </p>
      </div>
      {rerun ? (
        <Alert tone="warning">
          <p>The app stopped while this was running. It may already have happened: check before running it again.</p>
          <p>{rerunFacts(rerun)}</p>
          <p>Changes it makes outside the app aren’t undone by a swipe or a branch.</p>
        </Alert>
      ) : (
        approval.uncertain && <Alert tone="warning">{UNCERTAIN_TEXT}</Alert>
      )}
      {approval.storyScope && (
        <p className="text-xs font-medium [overflow-wrap:anywhere]">
          <StoryScope scope={approval.storyScope} at={approval.storyAt} />
        </p>
      )}
      {approval.rows.length > 0 && (
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"
          aria-label={rerun ? "What it sends to the server" : "What it will write"}
        >
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
        <Field
          label="Note for the assistant"
          description={`Sent with ${rerun ? "Don't run it" : "Decline"}, so it knows why. Optional.`}
        >
          <Textarea
            value={note}
            readOnly={!durable.ready}
            maxLength={2000}
            rows={2}
            onChange={(event) => durable.setText(event.target.value)}
          />
        </Field>
      )}
      <ErrorAlert error={action.error} title="Your answer wasn’t taken" />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          pending={answering === "allow"}
          disabled={busy}
          hint={
            rerun
              ? `Sends this call to ${rerun.connection} again, with the arguments shown.`
              : approval.plugin
                ? "Checks and runs this exact version from now on."
                : "Lets the assistant do this once."
          }
          onClick={() => void answer("allow")}
        >
          {rerun ? "Run it again" : approval.plugin ? "Turn on" : "Allow"}
        </Button>
        {!rerun && !approval.plugin && !approval.once && approval.capability !== "plugins.apply" && (
          <Button
            pending={answering === "allow_chat"}
            disabled={busy}
            hint={
              approval.grantTarget
                ? "Lets it use this here without asking again, for as long as it stays exactly as shown."
                : `Lets it do this kind of thing here without asking again (${approval.capabilityLabel}).`
            }
            onClick={() => void answer("allow_chat")}
          >
            Allow in this workshop
          </Button>
        )}
        <Button
          pending={answering === "deny"}
          disabled={busy}
          hint={
            rerun
              ? "Tells the assistant it wasn't run again. Nothing is sent."
              : approval.plugin
                ? "Leaves this plugin as it is."
                : "Tells the assistant not to. Nothing is changed."
          }
          onClick={() => void answer("deny")}
        >
          {rerun ? "Don't run it" : approval.plugin ? "Not now" : "Decline"}
        </Button>
        {!noting && (
          <Button
            variant="ghost"
            disabled={busy}
            hint={`Adds a note the assistant gets with ${rerun ? "Don't run it" : "Decline"}, saying why or what to do instead.`}
            onClick={() => setAdding(true)}
          >
            Add a note
          </Button>
        )}
      </div>
    </div>
  )
}

type Prompt = NonNullable<StepActionProps["step"]["approval"]>

/**
 * A subagent that couldn't be resumed with its reply (spec/SUBAGENTS.md §8): start its task again,
 * knowing what its first attempt already changed, or leave it.
 */
function RestartPanel({
  approval,
  restart,
  answer,
  answering,
  error
}: {
  approval: Prompt
  restart: NonNullable<Prompt["restart"]>
  answer: (choice: ApprovalAnswer) => Promise<void>
  answering: ApprovalAnswer | null
  error: Parameters<typeof ErrorAlert>[0]["error"]
}) {
  const busy = answering !== null
  return (
    <div
      data-approval={approval.toolCallId}
      data-restart={restart.handle}
      role="group"
      aria-label={approval.title}
      className="ml-5 flex flex-col gap-2 rounded-md border border-warning/50 bg-surface p-3 text-sm"
    >
      <p className="font-medium [overflow-wrap:anywhere]">{approval.title}</p>
      <Alert tone="warning">
        <p>The app stopped while this subagent was working, and what it had done can't be carried on.</p>
        {restart.effects.length > 0 ? (
          <>
            <p>Its first attempt already made these changes. Starting again may make them twice.</p>
            <ul aria-label="Changes its first attempt made" className="list-disc pl-5">
              {restart.effects.map((title, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">
                  {title}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>It had already taken steps. Starting again repeats them.</p>
        )}
      </Alert>
      {approval.rows.map((row) => (
        <p key={row.label} className="text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          <span className="text-muted">{row.label}: </span>
          {row.value}
        </p>
      ))}
      <ErrorAlert error={error} title="Your answer wasn’t taken" />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          pending={answering === "allow"}
          disabled={busy}
          hint="Starts this subagent's task over from the beginning."
          onClick={() => void answer("allow")}
        >
          Start the task again
        </Button>
        <Button
          pending={answering === "deny"}
          disabled={busy}
          hint="Tells the assistant the subagent couldn't be resumed. Nothing runs again."
          onClick={() => void answer("deny")}
        >
          Leave it
        </Button>
      </div>
    </div>
  )
}
