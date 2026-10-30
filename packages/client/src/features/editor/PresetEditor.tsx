import { SearchNavigation } from "./searchNavigation.ts"
// The preset editor (DESIGN §1.2, §6): the prompt list in order, with enable switches and
// drag to reorder; each prompt's role, position and depth; prefill text;
// and the regex scripts, which run only once the user allows them (ARCHITECTURE.md §9).
import { CARD_JOIN_PREFIX, CARD_JOIN_SUFFIX, type RegexScript } from "@rp/shared/docs/preset.ts"
import { type FieldPath } from "@rp/shared/editing.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { useContext, useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { PresetWarnings, PromptDocument } from "./PromptDocument.tsx"
import { presetEditorSections } from "./presetSections.ts"
import { SlotOutlet } from "../../slots.tsx"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { NumberField, SelectField, SwitchField, TextField } from "./controls.tsx"
import { type EditorStore, useEditorState, useText, useValue } from "./store.ts"

const POSTFIXES = [
  { value: "", label: "Nothing" },
  { value: " ", label: "A space" },
  { value: "\n", label: "A new line" },
  { value: "\n\n", label: "Two new lines" }
] as const

/**
 * What wraps each character's part of a per-field marker (DESIGN §5.0, ST's group join prefix
 * and suffix). Absent, the default applies, which an empty field doesn't show.
 */
function JoinWrapper({ store, which }: { store: EditorStore; which: "card_join_prefix" | "card_join_suffix" }) {
  const stored = useValue<string | undefined>(store, ["utility_prompts", which])
  const fallback = which === "card_join_prefix" ? CARD_JOIN_PREFIX : CARD_JOIN_SUFFIX
  return (
    <TextField
      store={store}
      path={["utility_prompts", which]}
      label={which === "card_join_prefix" ? "Before each character's part" : "After each character's part"}
      rows={2}
      mono
      description={
        stored === undefined
          ? `Not set: ${JSON.stringify(fallback)} is used. {{char}} is the character, <FIELDNAME> the field.`
          : "{{char}} is the character, <FIELDNAME> the field. Empty: nothing, as SillyTavern sends one character."
      }
    />
  )
}

// The group nudge, impersonation prompt and direction have their fixed End of request section (DESIGN §2.2).
const UTILITY: ReadonlyArray<readonly [key: string, label: string]> = [
  ["new_chat_prompt", "New chat"],
  ["new_group_chat_prompt", "New group chat"],
  ["new_example_chat_prompt", "New example chat"],
  ["continue_nudge_prompt", "Continue nudge"],
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
  const match = useContext(SearchNavigation)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (match?.path[0] !== "regex" || match.path[1] !== `id=${script.id}`) return
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [match, script.id])
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

export function PresetEditor({
  store,
  call,
  context,
  focus
}: {
  store: EditorStore
  call: Caller
  context?: PresetContext | null | undefined
  focus?: string | undefined
}) {
  const [goTo, setGoTo] = useState<{ readonly identifier: string } | null>(null)
  return (
    <>
      <PresetWarnings store={store} onGoTo={(identifier) => setGoTo({ identifier })} />
      <Card>
        <CardHeader
          title="Prompts"
          description="Sent in this order. Drag a handle or an outline name; arrow keys move a focused handle."
        />
        <PromptDocument store={store} context={context} focus={focus} goTo={goTo} />
      </Card>
      <SlotOutlet slot={presetEditorSections} props={{ store }} />
      <Card>
        <CardHeader title="Text and context" description="SillyTavern's prompt text switches." />
        <div className="flex flex-col gap-3">
          <SwitchField store={store} path={["pin_examples"]} label="Pin example dialogues" />
          <p className="text-sm text-muted">
            Give examples room before chat history. Off: history takes priority. Examples still need to fit the context
            limit.
          </p>
          <SwitchField store={store} path={["strip_examples"]} label="Strip example dialogues" />
          <p className="text-sm text-muted">
            Send no example dialogues, including lorebook examples. This takes priority over pinning.
          </p>
          <SwitchField store={store} path={["collapse_newlines"]} label="Collapse blank lines in character fields" />
          <p className="text-sm text-muted">
            Replace repeated newlines with one after expanding character fields. Saved messages and preset prompts keep
            their blank lines.
          </p>
        </div>
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
            <JoinWrapper store={store} which="card_join_prefix" />
            <JoinWrapper store={store} which="card_join_suffix" />
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
