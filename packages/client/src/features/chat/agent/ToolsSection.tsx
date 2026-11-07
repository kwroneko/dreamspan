// Tools and instructions are independent of card layout; the allowed list survives switching off.
import { useState, useSyncExternalStore } from "react"
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import { Checkbox, Switch } from "../../../ui/Choice.tsx"
import { Fieldset } from "../../../ui/Field.tsx"
import type { ChatSession } from "../session.ts"
import { useReplyTools } from "./replyTools.ts"

export function ToolsSection({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const { tools: available, error: readError } = useReplyTools(session)
  const [writeError, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const error = writeError ?? readError
  if (cast === null) return null
  const on = cast.agentEnabled === true
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
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
