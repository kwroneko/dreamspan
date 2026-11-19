// The agent's "When the reply wasn't sent" (spec/REPLY-CONTRACT.md §3.3): what the app tells the
// model when a reply that must be sent with the send tool ends in plain text instead. A prompt of
// the preset outside the order; without it, or empty, the app's default is sent (the Agent
// instructions' fallback rule).
import type { PresetPrompt } from "@dreamspan/shared/docs/preset.ts"
import { agentInstructionsPrompt } from "@dreamspan/shared/presetOrder.ts"
import { SEND_NUDGE_PROMPT, sendNudgeText } from "@dreamspan/shared/agentInstructions.ts"
import { Button } from "../../ui/Button.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { TextField } from "./controls.tsx"
import { type EditorStore, useText, useValue } from "./store.ts"

const DEFAULT = `Empty: the app's default is sent: “${sendNudgeText(true).replace(/\n+/g, " ")}”`

export function SendNudge({ store }: { store: EditorStore }) {
  const prompts = useValue<ReadonlyArray<PresetPrompt>>(store, ["prompts"]) ?? []
  const own = prompts.find((p) => p.identifier === SEND_NUDGE_PROMPT.identifier)
  const path = ["prompts", `identifier=${SEND_NUDGE_PROMPT.identifier}`, "content"]
  const text = useText(store, path)
  return (
    <Card>
      <CardHeader title={SEND_NUDGE_PROMPT.label} about={SEND_NUDGE_PROMPT.hint} />
      {own ? (
        <TextField
          store={store}
          path={path}
          label="Text"
          labelHidden
          rows={3}
          {...(text.trim() === "" ? { description: DEFAULT } : {})}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="min-w-0 flex-1">This preset sends the app's default.</span>
          <Button
            hint="Adds this text to the preset, empty so the default is still sent, ready to edit."
            onClick={() =>
              store.setValue(["prompts", `identifier=${SEND_NUDGE_PROMPT.identifier}`], {
                ...agentInstructionsPrompt,
                identifier: SEND_NUDGE_PROMPT.identifier,
                name: SEND_NUDGE_PROMPT.label,
                role: "user",
                content: ""
              })
            }
          >
            Add to preset
          </Button>
        </div>
      )}
    </Card>
  )
}
