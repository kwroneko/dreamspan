// Tools and instructions are independent of card layout; the allowed list survives switching off.
import { useState, useSyncExternalStore } from "react"
import type { CastChange } from "@dreamspan/shared/chatSetupApi.ts"
import { DEFAULT_REQUEST_CAP, MAX_REQUEST_CAP } from "@dreamspan/shared/state.ts"
import { Checkbox, RadioGroup, Switch } from "../../../ui/Choice.tsx"
import { Field, Fieldset, Input } from "../../../ui/Field.tsx"
import type { ChatSession } from "../session.ts"
import { McpServersFieldset } from "./McpServersFieldset.tsx"
import { useReplyTools } from "./replyTools.ts"

type SendPresence = "off" | "optional" | "required"

type Contract = "send_message" | "final_text" | "both"

/** A workshop's several-message contract isn't a choice here; a story never sets it. */
const contractOf = (stored: string | undefined): Contract =>
  stored === "final_text" || stored === "both" ? stored : "send_message"

/** What each way of giving the reply does, from when, and an example. */
const CONTRACT_ABOUT =
  "How the model hands over its reply, from the next reply on this branch. Send tool: only a message it sends with a tool is the reply, and it may stay silent instead; anything it writes along the way shows in the steps, and a model that keeps writing without sending is asked again, then the reply fails so you can resume or regenerate it. Plain answer: its last answer after any tools is the reply. Either: a sent message or its last answer. Example: a model that writes “Let me check the notes” before a lookup shows that line in the steps with Send tool, never in the message."

/** Why only the send tool is a choice while every reply must say who's in the scene. */
const FORCED =
  "Replies must say who's in the scene, and they say it when they send the reply, so the send tool is used."

/** What the setting does, when, and one example. */
const PRESENT_ABOUT =
  "Requires Separate contexts. Let each reply say which characters are there for it, from the next reply on this branch. Anyone it leaves out is marked away starting with that message, and is back once a reply names them again. Example: Wren's reply has Mira walk out and names only Wren and Tobin, so Mira is away until a later reply names her. Your own character and a narrator never change this way."

/** What the request cap is, in requests and steps, never turns (a turn is a message here). */
const CAP_ABOUT = `A reply that uses tools sends the model a request, gets back a tool call or the reply, and repeats. This caps how many requests one reply makes; the last one can't use tools, so the model writes the reply then. From 1 to ${MAX_REQUEST_CAP}; the default is ${DEFAULT_REQUEST_CAP}. Applies from the next reply on this branch. Example: at 3, a reply can look something up twice and must reply on the third request.`

/** The request cap, typed and saved when it's a whole number in range and the field is left. */
function RequestCapField({
  cap,
  disabled,
  onSave
}: {
  cap: number
  disabled: boolean
  onSave: (cap: number | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(cap)
  const value = Number(text)
  const valid = /^\d+$/.test(text.trim()) && value >= 1 && value <= MAX_REQUEST_CAP
  const commit = () => {
    if (draft === null) return
    setDraft(null)
    if (valid && value !== cap) onSave(value === DEFAULT_REQUEST_CAP ? null : value)
  }
  return (
    <Field
      label="Model requests per reply"
      about={CAP_ABOUT}
      description={`At most ${valid ? value : cap} model requests per reply.`}
      error={valid ? null : `A whole number from 1 to ${MAX_REQUEST_CAP}.`}
    >
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_REQUEST_CAP}
        step={1}
        value={text}
        disabled={disabled}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit()
        }}
      />
    </Field>
  )
}

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
  /** "Replies must say" makes the send tool the way (the reply names who's there with it). */
  const forced = cast.sendPresence === "required"
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
        <Fieldset legend="How the reply is given" about={CONTRACT_ABOUT}>
          <RadioGroup<Contract>
            aria-label="How the reply is given"
            value={forced ? "send_message" : contractOf(cast.outputContract)}
            disabled={pending}
            onValueChange={(contract) => void write({ _tag: "OutputContract", contract })}
            options={[
              {
                value: "send_message",
                label: "Send tool",
                description: "Only a sent message is the reply; other text shows in the steps."
              },
              {
                value: "final_text",
                label: "Plain answer",
                description: "The model's last answer is the reply.",
                ...(forced ? { disabled: true, hint: FORCED } : {})
              },
              {
                value: "both",
                label: "Either",
                description: "A sent message or the last answer.",
                ...(forced ? { disabled: true, hint: FORCED } : {})
              }
            ]}
          />
          {forced && <p className="text-sm text-muted">Send tool only, while replies must say who's in the scene.</p>}
        </Fieldset>
      )}
      {on && (
        <RequestCapField
          cap={cast.requestCap ?? DEFAULT_REQUEST_CAP}
          disabled={pending}
          onSave={(cap) => void write({ _tag: "RequestCap", cap })}
        />
      )}
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
