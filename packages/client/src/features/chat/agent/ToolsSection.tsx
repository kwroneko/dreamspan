// Tools and instructions are independent of card layout; the allowed list survives switching off.
import { useState, useSyncExternalStore } from "react"
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import { Checkbox, RadioGroup, Switch } from "../../../ui/Choice.tsx"
import { Fieldset } from "../../../ui/Field.tsx"
import type { ChatSession } from "../session.ts"
import { McpServersFieldset } from "./McpServersFieldset.tsx"
import { useReplyTools } from "./replyTools.ts"

type SendPresence = "off" | "optional" | "required"

/** What the setting does, when, and one example. */
const PRESENT_ABOUT =
  "Requires Separate contexts. Let each reply say which characters are there for it, from the next reply on this branch. Anyone it leaves out is marked away starting with that message, and is back once a reply names them again. Example: Wren's reply has Mira walk out and names only Wren and Tobin, so Mira is away until a later reply names her. Your own character and a narrator never change this way."

export function ToolsSection({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const { tools: available, error: readError } = useReplyTools(session)
  const [writeError, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  if (cast === null) return null
  const on = cast.agentEnabled === true
  const error =
    writeError ??
    readError ??
    (on && cast.sendPresence !== undefined && (cast.contextPerSpeaker ?? "shared") === "shared"
      ? "Choose Separate contexts before asking replies to say who's in the scene. One shared context lets every character read the whole chat."
      : null)
  const tools = cast.agentTools ?? available?.defaultTools ?? []
  const write = async (change: CastChange) => {
    setPending(true)
    const outcome = await session.changeCast(change)
    setPending(false)
    setError(outcome.ok ? null : `Tools weren't changed: ${outcome.error.message}`)
  }
  return (
    <section aria-label="Tools" className="flex flex-col gap-3">
      <Switch
        checked={on}
        disabled={pending}
        onCheckedChange={(next) => void write({ _tag: "AgentEnabled", on: next })}
        hint={on ? "Click to turn tools off." : "Click to let the model use tools while writing replies."}
        about="Let the model look things up and keep notes before replying. Applies from the next reply on this branch."
      >
        Tools
      </Switch>
      {on && available && (
        <Fieldset legend="Allowed tools" about="Choose what the model may do while writing a reply.">
          {available.tools.length === 0 ? (
            <p className="text-sm text-muted">No tools are installed.</p>
          ) : (
            available.tools.map((tool) => (
              <Checkbox
                key={tool.id}
                checked={tools.includes(tool.id)}
                disabled={pending}
                hint={`Click to ${tools.includes(tool.id) ? "disallow" : "allow"}: ${tool.explanation}.`}
                hintInline={false}
                onCheckedChange={(next) =>
                  void write({
                    _tag: "AgentTools",
                    tools: available.tools.map((t) => t.id).filter((id) => (id === tool.id ? next : tools.includes(id)))
                  })
                }
              >
                {tool.explanation}
              </Checkbox>
            ))
          )}
        </Fieldset>
      )}
      {on && <McpServersFieldset session={session} choices={cast.agentMcp ?? {}} />}
      {on && (
        <Fieldset legend="Who's in the scene" about={PRESENT_ABOUT}>
          <RadioGroup<SendPresence>
            aria-label="Who's in the scene"
            value={cast.sendPresence ?? "off"}
            disabled={pending}
            onValueChange={(mode) => void write({ _tag: "SendPresence", mode })}
            options={[
              { value: "off", label: "Replies don't say", description: "Only you, or a tool, mark someone away." },
              {
                value: "optional",
                label: "Replies may say",
                description: "A reply can name who's there when someone leaves or returns."
              },
              { value: "required", label: "Replies must say", description: "Every reply names who's there." }
            ]}
          />
        </Fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
