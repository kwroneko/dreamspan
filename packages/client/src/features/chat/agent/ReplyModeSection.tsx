// The "This chat" tab's Reply mode (spec/AGENTIC.md §6): how the model writes this chat's replies,
// from the modes the server has registered, written as `orchestration.mode` at the leaf shown, so
// it follows the branch and changes the next reply only. For a mode that uses tools, the tools it
// may use, each a checkbox, written as `agent.tools`.
import type { ReplyModes } from "@rp/shared/agent.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Checkbox } from "../../../ui/Choice.tsx"
import { Field, Fieldset } from "../../../ui/Field.tsx"
import { Select } from "../../../ui/Select.tsx"
import type { ChatSession } from "../session.ts"

const PLAIN = "plain"

/** The registered modes and tools, read once a page: they change only when plugins do. */
let known: Promise<ReplyModes | string> | null = null
const readModes = (session: ChatSession) =>
  (known ??= session
    .call((client) => client("ListReplyModes", {}))
    .then((result) => {
      if (result.ok) return result.value
      known = null
      return `The reply modes couldn't be read: ${result.error.message}`
    }))

export function ReplyModeSection({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const [modes, setModes] = useState<ReplyModes | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ mode?: string; tools?: ReadonlyArray<string> } | null>(null)
  useEffect(() => {
    let active = true
    void readModes(session).then((result) => {
      if (!active) return
      if (typeof result === "string") setError(result)
      else setModes(result)
    })
    return () => {
      active = false
    }
  }, [session])
  if (cast === null || modes === null)
    return error ? (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    ) : null

  const modeId = pending?.mode ?? cast.replyMode ?? PLAIN
  const mode = modes.modes.find((m) => m.id === modeId)
  const tools = pending?.tools ?? cast.agentTools ?? mode?.tools ?? []
  const write = async (change: { mode: string } | { tools: ReadonlyArray<string> }) => {
    setPending("mode" in change ? { mode: change.mode } : { tools: change.tools })
    const outcome = await session.changeCast(
      "mode" in change ? { _tag: "ReplyMode", mode: change.mode } : { _tag: "AgentTools", tools: change.tools }
    )
    setPending(null)
    setError(outcome.ok ? null : `The reply mode wasn't changed: ${outcome.error.message}`)
  }
  const items = modes.modes.map((m) => ({ value: m.id, label: m.label, description: m.description }))
  // A mode a plugin took away still shows as the chat's, so the select never silently says Plain.
  if (!mode) items.push({ value: modeId, label: `${modeId} (not available)`, description: "No longer installed." })

  return (
    <section aria-label="Reply mode" className="flex flex-col gap-3">
      <Field
        label="Reply mode"
        about="How the model writes this chat's replies: in one go, or using tools first. A change applies from the next reply, on this branch."
        description={mode?.description ?? "This mode isn't available: the next reply fails until another is chosen."}
      >
        <Select
          items={items}
          value={modeId}
          disabled={pending !== null}
          onValueChange={(next) => next !== modeId && void write({ mode: next })}
        />
      </Field>
      {mode?.agentic && (
        <Fieldset
          legend="Tools"
          about="What the model may do before it writes a reply. A change applies from the next reply, on this branch."
        >
          {modes.tools.length === 0 ? (
            <p className="text-sm text-muted">No tools are installed.</p>
          ) : (
            modes.tools.map((tool) => (
              <Checkbox
                key={tool.id}
                checked={tools.includes(tool.id)}
                disabled={pending !== null}
                onCheckedChange={(on) =>
                  void write({
                    // In the order the tools are listed, so the request stays the same for the same choice.
                    tools: modes.tools.map((t) => t.id).filter((id) => (id === tool.id ? on : tools.includes(id)))
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
