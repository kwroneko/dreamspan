import { Tooltip } from "../../ui/Tooltip.tsx"
// The card as this chat reads it, read-only, for a chat that uses an earlier version: the tab's
// text boxes edit the library's latest, so this is the one place the chat's own version shows.
import type { ChatCard } from "@dreamspan/shared/chatSetupApi.ts"
import { useId, useState } from "react"
import { Disclosure } from "../../ui/Surface.tsx"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Longer than this, a field shows its start and "Show more". */
const LONG = 320

function DefinitionField({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const long = text.length > LONG || text.split("\n").length > 6
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd
        id={id}
        className={`text-sm whitespace-pre-wrap [overflow-wrap:anywhere] ${long && !open ? "line-clamp-6" : ""}`}
      >
        {text}
      </dd>
      {long && (
        <Tooltip label={open ? "Click to collapse the definition." : "Click to show the full definition."}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
            className="self-start text-xs text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {open ? "Show less" : "Show more"}
          </button>
        </Tooltip>
      )}
    </div>
  )
}

export function ChatDefinition({ name, info }: { name: string; info: ChatCard }) {
  const { definition } = info
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["Description", definition.description],
    ["First message", definition.firstMessage],
    ["Personality", definition.personality],
    ["Scenario", definition.scenario],
    ["Example messages", definition.exampleDialogue],
    ["Creator's notes", definition.creatorNotes]
  ]
  const shown = fields.filter(([, text]) => text.trim() !== "")
  const empty = fields.filter(([, text]) => text.trim() === "").map(([label]) => label.toLowerCase())
  return (
    <Disclosure title="The version this chat uses">
      <section aria-label={`${name} as this chat uses them`} className="flex flex-col gap-3">
        {shown.length > 0 && (
          <dl className="flex flex-col gap-3">
            {shown.map(([label, text]) => (
              <DefinitionField key={label} label={label} text={text} />
            ))}
          </dl>
        )}
        <p className="text-xs text-muted">
          {[
            definition.alternateGreetings > 0
              ? `${plural(definition.alternateGreetings, "alternate greeting", "alternate greetings")}.`
              : "",
            empty.length > 0 ? `Empty: ${empty.join(", ")}.` : ""
          ]
            .filter((part) => part !== "")
            .join(" ")}
        </p>
      </section>
    </Disclosure>
  )
}
