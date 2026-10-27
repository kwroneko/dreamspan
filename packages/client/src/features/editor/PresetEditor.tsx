// The preset editor (DESIGN §1.2, §6): the prompt list in order, with enable switches and
// drag to reorder; each prompt's role, position and depth; prefill text;
// and the regex scripts, which run only once the user allows them (ARCHITECTURE.md §9).
import type { PresetPrompt, PromptOrderEntry, RegexScript } from "@rp/shared/docs/preset.ts"
import { type FieldPath, valueField } from "@rp/shared/editing.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { type ReactNode, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { SortableList } from "../../ui/SortableList.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { FieldTools, NumberField, SelectField, SwitchField, TextField } from "./controls.tsx"
import { type EditorStore, useEditorState, useText, useValue } from "./store.ts"

/** What the assembler puts in place of each marker. */
const MARKERS: Record<string, string> = {
  chatHistory: "the chat's messages",
  dialogueExamples: "the card's example messages",
  worldInfoBefore: "lorebook entries placed before the card",
  worldInfoAfter: "lorebook entries placed after the card",
  charDescription: "the card's description",
  charPersonality: "the card's personality",
  scenario: "the card's scenario",
  personaDescription: "your persona's description"
}

const ROLES = [
  { value: "system", label: "System" },
  { value: "user", label: "User" },
  { value: "assistant", label: "Assistant" }
] as const

const POSITIONS = [
  { value: "relative", label: "In the prompt, in this order" },
  { value: "absolute", label: "In the chat, at a depth" }
] as const

const prompt = (identifier: string): FieldPath => ["prompts", `identifier=${identifier}`]

function PromptEditor({
  store,
  identifier,
  onRemove
}: {
  store: EditorStore
  identifier: string
  onRemove: () => void
}) {
  const at = prompt(identifier)
  const value = useValue<PresetPrompt>(store, at)
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3 pb-1 sm:pl-10">
      <TextField store={store} path={[...at, "name"]} label="Name" />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField store={store} path={[...at, "role"]} label="Role" items={ROLES} />
        <SelectField store={store} path={[...at, "injection_position"]} label="Position" items={POSITIONS} />
      </div>
      {value.injection_position === "absolute" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField store={store} path={[...at, "injection_depth"]} label="Depth" integer min={0} max={10000} />
          <NumberField store={store} path={[...at, "injection_order"]} label="Order at that depth" />
        </div>
      )}
      {value.marker ? (
        <p className="text-sm text-muted">
          A marker: when the prompt is assembled, {MARKERS[identifier] ?? "the assembler's text"} goes here. It has no
          text of its own.
        </p>
      ) : (
        <TextField store={store} path={[...at, "content"]} label="Prompt" rows={8} />
      )}
      <SwitchField
        store={store}
        path={[...at, "forbid_overrides"]}
        label="A card can't replace it"
        description="Cards with their own system prompt or post-history instructions leave this one as it is."
      />
      {!value.system_prompt && !value.marker && (
        <div>
          <Button variant="ghost" onClick={onRemove}>
            Delete the prompt
          </Button>
        </div>
      )}
    </div>
  )
}

function PromptRow({
  store,
  entry,
  handle,
  onToggle,
  onTakeOut,
  onRemove
}: {
  store: EditorStore
  entry: PromptOrderEntry
  handle: ReactNode
  onToggle: (enabled: boolean) => void
  onTakeOut: () => void
  onRemove: () => void
}) {
  const at = prompt(entry.identifier)
  const value = useValue<PresetPrompt | undefined>(store, at)
  const name = useText(store, [...at, "name"]) || entry.identifier
  const [open, setOpen] = useState(false)
  if (value === undefined) return null
  return (
    <div className="flex flex-col gap-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        {handle}
        <Switch checked={entry.enabled} onCheckedChange={onToggle}>
          <span className="sr-only">Send {name}</span>
        </Switch>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`min-w-0 text-sm font-medium [overflow-wrap:anywhere] ${entry.enabled ? "" : "text-muted"}`}>
            {name}
          </span>
          {value.marker && <Badge>marker</Badge>}
          {value.role !== "system" && <Badge>{value.role}</Badge>}
          {value.injection_position === "absolute" && (
            <Badge tone="accent">in chat, depth {value.injection_depth}</Badge>
          )}
        </div>
        <Button variant="ghost" aria-expanded={open} aria-label={`Edit ${name}`} onClick={() => setOpen(!open)}>
          {open ? "Close" : "Edit"}
        </Button>
      </div>
      {open && (
        <>
          <PromptEditor store={store} identifier={entry.identifier} onRemove={onRemove} />
          <div className="sm:pl-10">
            <Button variant="ghost" onClick={onTakeOut}>
              Take it out of the order
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function Prompts({ store }: { store: EditorStore }) {
  const order = useValue<ReadonlyArray<PromptOrderEntry>>(store, ["order"]) ?? []
  const prompts = useValue<ReadonlyArray<PresetPrompt>>(store, ["prompts"]) ?? []
  const ordered = new Set(order.map((entry) => entry.identifier))
  const unordered = prompts.filter((p) => !ordered.has(p.identifier))
  const names = new Map(prompts.map((p) => [p.identifier, p.name || p.identifier]))
  const setOrder = (next: ReadonlyArray<PromptOrderEntry>) => store.setValue(["order"], next)

  const add = () => {
    const identifier = uuidv7()
    store.setValue(prompt(identifier), {
      identifier,
      name: "New prompt",
      role: "system",
      content: "",
      system_prompt: false,
      marker: false,
      injection_position: "relative",
      injection_depth: 4,
      injection_order: 100,
      injection_trigger: [],
      forbid_overrides: false
    })
    setOrder([...order, { identifier, enabled: true }])
  }

  const remove = (identifier: string) => {
    setOrder(order.filter((entry) => entry.identifier !== identifier))
    void store.removeItem(prompt(identifier))
  }

  return (
    <div className="flex flex-col gap-3">
      <SortableList
        items={order}
        itemKey={(entry) => entry.identifier}
        itemLabel={(entry) => names.get(entry.identifier) ?? entry.identifier}
        label="Prompt order"
        onMove={(from, to) => {
          const next = [...order]
          next.splice(to, 0, ...next.splice(from, 1))
          setOrder(next)
        }}
      >
        {(entry, handle) => (
          <PromptRow
            store={store}
            entry={entry}
            handle={handle}
            onToggle={(enabled) => setOrder(order.map((e) => (e === entry ? { ...e, enabled } : e)))}
            onTakeOut={() => setOrder(order.filter((e) => e !== entry))}
            onRemove={() => remove(entry.identifier)}
          />
        )}
      </SortableList>
      <FieldTools store={store} field={valueField(["order"])} label="Prompt order" />
      <div>
        <Button onClick={add}>Add a prompt</Button>
      </div>
      {unordered.length > 0 && (
        <Fieldset legend="Not in the order" description="These prompts are kept, but never sent.">
          <ul className="flex flex-col divide-y divide-border">
            {unordered.map((p) => (
              <li key={p.identifier} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{p.name || p.identifier}</span>
                <Button
                  variant="ghost"
                  aria-label={`Add ${p.name || p.identifier} to the order`}
                  onClick={() => setOrder([...order, { identifier: p.identifier, enabled: true }])}
                >
                  Add to the order
                </Button>
              </li>
            ))}
          </ul>
        </Fieldset>
      )}
    </div>
  )
}

const POSTFIXES = [
  { value: "", label: "Nothing" },
  { value: " ", label: "A space" },
  { value: "\n", label: "A new line" },
  { value: "\n\n", label: "Two new lines" }
] as const

const UTILITY: ReadonlyArray<readonly [key: string, label: string]> = [
  ["impersonation_prompt", "Impersonation"],
  ["new_chat_prompt", "New chat"],
  ["new_group_chat_prompt", "New group chat"],
  ["new_example_chat_prompt", "New example chat"],
  ["continue_nudge_prompt", "Continue nudge"],
  ["group_nudge_prompt", "Group nudge"],
  ["send_if_empty", "Sent when you send nothing"],
  ["wi_format", "Lorebook format ({0} is the entries)"],
  ["scenario_format", "Scenario format"],
  ["personality_format", "Personality format"]
]

const PLACEMENTS = [
  [1, "Your messages"],
  [2, "Replies"],
  [3, "Slash commands"],
  [5, "Lorebook entries"],
  [6, "Reasoning"]
] as const

function ScriptPlacement({ store, path }: { store: EditorStore; path: FieldPath }) {
  const placement = useValue<ReadonlyArray<number>>(store, path) ?? []
  return (
    <Fieldset legend="Applies to">
      <div className="flex flex-wrap gap-4">
        {PLACEMENTS.map(([value, label]) => (
          <Checkbox
            key={value}
            checked={placement.includes(value)}
            onCheckedChange={(checked) =>
              store.setValue(
                path,
                checked ? [...placement, value].sort((a, b) => a - b) : placement.filter((other) => other !== value)
              )
            }
          >
            {label}
          </Checkbox>
        ))}
      </div>
    </Fieldset>
  )
}

function Script({ store, script }: { store: EditorStore; script: RegexScript }) {
  const at = ["regex", `id=${script.id}`]
  const name = useText(store, [...at, "name"]) || "Unnamed script"
  const [open, setOpen] = useState(false)
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
          {name}
          {script.disabled && <Badge>off</Badge>}
          {script.prompt_only && <Badge>prompt only</Badge>}
          {script.markdown_only && <Badge>display only</Badge>}
        </span>
        <Button variant="ghost" aria-expanded={open} aria-label={`Edit ${name}`} onClick={() => setOpen(!open)}>
          {open ? "Close" : "Edit"}
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-3">
          <TextField store={store} path={[...at, "name"]} label="Name" />
          <TextField store={store} path={[...at, "find_regex"]} label="Find (a regular expression)" mono />
          <TextField store={store} path={[...at, "replace_string"]} label="Replace with" rows={2} mono />
          <ScriptPlacement store={store} path={[...at, "placement"]} />
          <div className="flex flex-wrap gap-4">
            <SwitchField store={store} path={[...at, "disabled"]} label="Off" checkbox />
            <SwitchField store={store} path={[...at, "prompt_only"]} label="Only in the prompt" checkbox />
            <SwitchField store={store} path={[...at, "markdown_only"]} label="Only in what's shown" checkbox />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField store={store} path={[...at, "min_depth"]} label="From depth (empty: any)" nullable integer />
            <NumberField store={store} path={[...at, "max_depth"]} label="To depth (empty: any)" nullable integer />
          </div>
          <div>
            <Button variant="ghost" onClick={() => void store.removeItem(at)}>
              Delete the script
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

function Regex({ store, call }: { store: EditorStore; call: Caller }) {
  const scripts = useValue<ReadonlyArray<RegexScript>>(store, ["regex"]) ?? []
  const approved = useValue<boolean>(store, ["regex_approved"]) === true
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const { snapshot } = useEditorState(store)
  const saved = (snapshot!.doc.regex as ReadonlyArray<RegexScript> | undefined) ?? []

  const setApproval = async (next: boolean) => {
    setPending(true)
    const result = await call(
      (client) =>
        client("SetRegexApproval", {
          refId: store.refId,
          approved: next,
          expectedRowVersion: snapshot!.ref.rowVersion
        }),
      ["library"]
    )
    setPending(false)
    setConfirming(false)
    if (result.ok) await store.refresh()
    else setError(result.error)
  }

  const add = () => {
    const id = uuidv7()
    store.setValue(["regex", `id=${id}`], {
      id,
      name: "New script",
      find_regex: "",
      replace_string: "",
      trim_strings: [],
      placement: [2],
      disabled: true,
      markdown_only: false,
      prompt_only: false,
      run_on_edit: true,
      substitute_regex: "none",
      min_depth: null,
      max_depth: null
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error} />
      {saved.length > 0 &&
        (approved ? (
          <Alert
            tone="success"
            title="These scripts are allowed to run"
            actions={
              <Button pending={pending} onClick={() => void setApproval(false)}>
                Stop them
              </Button>
            }
          />
        ) : (
          <Alert
            tone="warning"
            title="These scripts don't run until you allow them"
            actions={
              <Button variant="primary" onClick={() => setConfirming(true)}>
                Allow them
              </Button>
            }
          >
            <p>
              A preset from a file never allows its own scripts. Read them first: they rewrite text as it's sent and
              shown.
            </p>
          </Alert>
        ))}
      {scripts.length === 0 ? (
        <EmptyState title="No regex scripts" />
      ) : (
        <ul aria-label="Regex scripts" className="flex flex-col divide-y divide-border">
          {scripts.map((script) => (
            <Script key={script.id} store={store} script={script} />
          ))}
        </ul>
      )}
      <div>
        <Button onClick={add}>Add a script</Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Allow ${saved.length === 1 ? "this script" : `these ${saved.length} scripts`} to run?`}
        description="They'll rewrite text in the prompt and on screen as their patterns say. Unsaved changes to them are allowed too once saved."
        confirmLabel="Allow them"
        pending={pending}
        onConfirm={() => void setApproval(true)}
      >
        <ul className="flex flex-col gap-1 text-sm">
          {saved.map((script) => (
            <li key={script.id} className="[overflow-wrap:anywhere]">
              <span className="font-medium">{script.name || "Unnamed script"}</span>:{" "}
              <code className="font-mono">{script.find_regex}</code>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  )
}

export function PresetEditor({ store, call }: { store: EditorStore; call: Caller }) {
  return (
    <>
      <Card>
        <CardHeader
          title="Prompts"
          description="Sent in this order. Drag a prompt by its handle, or focus it and use the arrow keys."
        />
        <Prompts store={store} />
      </Card>
      <Card>
        <CardHeader title="Prefill" description="Dropped where the provider can't take it." />
        <div className="flex flex-col gap-3">
          <TextField store={store} path={["prefill", "assistant"]} label="Start of the reply" rows={3} />
          <TextField
            store={store}
            path={["prefill", "impersonation"]}
            label="Start of a reply written as you"
            rows={3}
          />
          <SwitchField store={store} path={["prefill", "continue"]} label="Continue by prefilling the message" />
          <SelectField
            store={store}
            path={["prefill", "continue_postfix"]}
            label="After a continued message"
            items={POSTFIXES}
          />
        </div>
      </Card>
      <Card>
        <CardHeader title="Utility prompts" description="Text used in particular situations." />
        <details>
          <summary className="cursor-pointer text-sm text-muted">Show the {UTILITY.length} utility prompts</summary>
          <div className="mt-3 flex flex-col gap-3">
            {UTILITY.map(([key, label]) => (
              <TextField key={key} store={store} path={["utility_prompts", key]} label={label} rows={3} />
            ))}
          </div>
        </details>
      </Card>
      <Card>
        <CardHeader title="Regex scripts" />
        <Regex store={store} call={call} />
      </Card>
    </>
  )
}
