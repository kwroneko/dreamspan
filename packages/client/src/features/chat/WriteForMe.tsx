import { useSyncExternalStore } from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { SquareIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { composerChoice } from "./speaker.ts"
import { composerControls, type ComposerControlContext } from "./composerControls.tsx"
import type { DraftWriter } from "./draftWriter.ts"

function WriteControl({ writing, ready, busy, prefsReady, guidance, session }: ComposerControlContext) {
  if (!writing) return null
  const start = () => writing.start(guidance ? () => composerChoice(session).change({ guidance: false }) : undefined)
  return <WriteButton writing={writing} disabled={!ready || busy || !prefsReady} start={start} />
}
function WriteButton({
  writing,
  disabled,
  start
}: {
  writing: DraftWriter
  disabled: boolean
  start: () => Promise<void>
}) {
  const state = useSyncExternalStore(writing.subscribe, writing.snapshot)
  const hint = state.running
    ? "Stops writing and keeps the text that arrived."
    : "Drafts your next message with this chat’s model. Adds it after your text for you to edit and send."
  const label = state.running ? "Stop writing" : "Write for me"
  const run = () => {
    if (state.running) writing.stop()
    else void start()
  }
  return (
    <SquareIconButton label={label} hint={hint} disabled={!state.running && disabled} variant="ghost" onClick={run}>
      <Icon name={state.running ? "stop" : "write"} size={18} />
    </SquareIconButton>
  )
}

function DraftResult({ writing, session, view }: ComposerControlContext) {
  if (!writing) return null
  return <Result writing={writing} chatId={session.id} forkId={view.forkId} />
}
function Result({ writing, chatId, forkId }: { writing: DraftWriter; chatId: string; forkId: string | null }) {
  const state = useSyncExternalStore(writing.subscribe, writing.snapshot)
  if (!state.rolloutId && !state.error && !state.undo) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-testid="draft-result">
      {state.running && (
        <span role="status" className="text-muted">
          Writing for you…
        </span>
      )}
      {state.error && (
        <span role="alert" className="min-w-0 basis-full wrap-break-word text-danger">
          {state.error}
        </span>
      )}
      {state.undo && (
        <Button
          hint="Restores your draft exactly as it was before Write for me."
          variant="ghost"
          onClick={writing.undo}
        >
          Undo draft
        </Button>
      )}
      {state.rolloutId && (
        <Tooltip label="Shows the request and its cost.">
          <Link
            className="text-accent underline underline-offset-2"
            to="/chats/$chatId/draft-request/$rolloutId"
            params={{ chatId, rolloutId: state.rolloutId }}
            search={{ fork: forkId ?? undefined }}
          >
            View request
          </Link>
        </Tooltip>
      )}
    </div>
  )
}
export const registerWriteForMe = () => [
  composerControls.register({
    id: "composer.write-for-me",
    source: import.meta.url,
    order: 50,
    placement: "tools",
    available: ({ view }) => view.chat?.kind === "rp",
    component: WriteControl
  }),
  composerControls.register({
    id: "composer.draft-result",
    source: import.meta.url,
    order: 50,
    placement: "banner",
    available: ({ view }) => view.chat?.kind === "rp",
    component: DraftResult
  })
]
