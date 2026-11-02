// The regex script form (ST's regex extension), shared by every list that holds scripts: a
// preset's and a card's (bound to their editor's draft store) and the account's global list
// (a local draft saved with SetGlobalRegex). Same fields and layout everywhere; only the
// binding differs. Presets and cards from files run their scripts only once the user allows
// them (ARCHITECTURE.md §9); global scripts are the user's own and need no approval.
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import type { FieldPath } from "@rp/shared/editing.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { useContext, useEffect, useState, type ReactNode } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { Field, Fieldset, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import type { DisplayResult } from "../chat/displayPipeline.ts"
import { runRegexJob } from "../chat/displayWorker.ts"
import type { Caller } from "./caller.ts"
import { LinesField, NumberField, SelectField, SwitchField, TextField } from "./controls.tsx"
import { addScriptChange } from "./regexAdd.ts"
import { SearchNavigation } from "./searchNavigation.ts"
import { type EditorStore, useEditorState, useText, useValue } from "./store.ts"

/** ST's placements (regexScript.ts), with what each reaches here. */
const PLACEMENTS: ReadonlyArray<readonly [number, string, string?]> = [
  [1, "Your messages", "Messages on your side of the chat."],
  [2, "Replies", "Messages on the characters' side: the model's replies."],
  [3, "Slash commands", "Slash commands. Nothing here runs them, so this changes nothing."],
  [5, "Lorebook entries", "Entries' text as it goes into the prompt, for a script that changes the prompt."],
  [6, "Reasoning", "A reply's reasoning, and the text of its reply sections."]
]

const SUBSTITUTIONS: ReadonlyArray<{
  readonly value: RegexScript["substitute_regex"]
  readonly label: string
  readonly description: string
}> = [
  { value: "none", label: "Not expanded", description: "{{char}} and other macros in the pattern stay as typed." },
  {
    value: "raw",
    label: "Expanded",
    description:
      "Match the values of macros such as {{char}}. Regex symbols in those values act as part of the pattern."
  },
  {
    value: "escaped",
    label: "Expanded and escaped",
    description:
      "Match macro values as plain text. Works only for display; prompts and saved messages skip these scripts."
  }
]

/** A new script: off until the user turns it on, applied to replies. */
export const newScript = (): RegexScript => ({
  id: uuidv7(),
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

/** Where a script's fields are read and written. */
export type ScriptBinding =
  | { readonly kind: "store"; readonly store: EditorStore; readonly at: FieldPath }
  | { readonly kind: "local"; readonly script: RegexScript; readonly change: (patch: Partial<RegexScript>) => void }

type TextKey = "name" | "find_regex" | "replace_string"
type CheckKey = "disabled" | "prompt_only" | "markdown_only" | "run_on_edit"
type DepthKey = "min_depth" | "max_depth"

function ScriptText({
  binding,
  field,
  label,
  rows,
  mono = false
}: {
  binding: ScriptBinding
  field: TextKey
  label: string
  rows?: number
  mono?: boolean
}) {
  if (binding.kind === "store")
    return (
      <TextField
        store={binding.store}
        path={[...binding.at, field]}
        label={label}
        mono={mono}
        {...(rows === undefined ? {} : { rows })}
      />
    )
  const props = {
    value: binding.script[field],
    spellCheck: !mono,
    className: mono ? "font-mono" : ""
  }
  return (
    <Field label={label}>
      {rows === undefined ? (
        <Input {...props} onValueChange={(value) => binding.change({ [field]: value })} />
      ) : (
        <Textarea
          {...props}
          rows={rows}
          className={`resize-y ${props.className}`}
          onChange={(event) => binding.change({ [field]: event.currentTarget.value })}
        />
      )}
    </Field>
  )
}

const LINES_LABEL = "Remove from each match (one per line)"

function LocalLines({ binding }: { binding: Extract<ScriptBinding, { kind: "local" }> }) {
  // Kept as typed, so a new empty line can be typed into; empty lines aren't saved.
  const [typed, setTyped] = useState<string | null>(null)
  return (
    <Field label={LINES_LABEL}>
      <Textarea
        rows={2}
        spellCheck={false}
        className="resize-y font-mono"
        value={typed ?? binding.script.trim_strings.join("\n")}
        onChange={(event) => {
          const text = event.currentTarget.value
          setTyped(text)
          binding.change({ trim_strings: text.split("\n").filter((line) => line !== "") })
        }}
        onBlur={() => setTyped(null)}
      />
    </Field>
  )
}

function ScriptLines({ binding }: { binding: ScriptBinding }) {
  return binding.kind === "store" ? (
    <LinesField store={binding.store} path={[...binding.at, "trim_strings"]} label={LINES_LABEL} />
  ) : (
    <LocalLines binding={binding} />
  )
}

function ScriptCheck({
  binding,
  field,
  label,
  description
}: {
  binding: ScriptBinding
  field: CheckKey
  label: string
  description?: string
}) {
  if (binding.kind === "store")
    return (
      <SwitchField store={binding.store} path={[...binding.at, field]} label={label} about={description} checkbox />
    )
  return (
    <Checkbox
      checked={binding.script[field]}
      onCheckedChange={(checked) => binding.change({ [field]: checked })}
      about={description}
    >
      {label}
    </Checkbox>
  )
}

/** What a script's depths count, said under each. */
const DEPTH_NOTE =
  "Limit the script to messages this far back: 0 is the newest. Empty means any depth. This affects display and prompts; rewriting saved messages ignores depth."

function LocalDepth({
  binding,
  field,
  label
}: {
  binding: Extract<ScriptBinding, { kind: "local" }>
  field: DepthKey
  label: string
}) {
  const value = binding.script[field]
  const [typed, setTyped] = useState<string | null>(null)
  return (
    <Field label={label} about={DEPTH_NOTE}>
      <Input
        type="number"
        inputMode="numeric"
        step={1}
        value={typed ?? (value === null ? "" : String(value))}
        onValueChange={(text) => {
          setTyped(text)
          if (text.trim() === "") binding.change({ [field]: null })
          else if (Number.isInteger(Number(text))) binding.change({ [field]: Number(text) })
        }}
        onBlur={() => setTyped(null)}
      />
    </Field>
  )
}

function ScriptDepth({ binding, field, label }: { binding: ScriptBinding; field: DepthKey; label: string }) {
  return binding.kind === "store" ? (
    <NumberField
      store={binding.store}
      path={[...binding.at, field]}
      label={label}
      about={DEPTH_NOTE}
      nullable
      integer
    />
  ) : (
    <LocalDepth binding={binding} field={field} label={label} />
  )
}

const SUBSTITUTE_LABEL = "Macros in the pattern"

function ScriptSubstitute({ binding }: { binding: ScriptBinding }) {
  if (binding.kind === "store")
    return (
      <SelectField
        store={binding.store}
        path={[...binding.at, "substitute_regex"]}
        label={SUBSTITUTE_LABEL}
        items={SUBSTITUTIONS}
        fallback="none"
      />
    )
  return (
    <Field label={SUBSTITUTE_LABEL}>
      <Select
        items={SUBSTITUTIONS}
        value={binding.script.substitute_regex}
        onValueChange={(substitute_regex) => binding.change({ substitute_regex })}
      />
    </Field>
  )
}

function PlacementChecks({
  placement,
  onChange
}: {
  placement: ReadonlyArray<number>
  onChange: (next: ReadonlyArray<number>) => void
}) {
  return (
    <Fieldset legend="Applies to">
      <div className="flex flex-col gap-2">
        {PLACEMENTS.map(([value, label, description]) => (
          <Checkbox
            key={value}
            about={description}
            checked={placement.includes(value)}
            onCheckedChange={(checked) =>
              onChange(
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

function StorePlacement({ store, path }: { store: EditorStore; path: FieldPath }) {
  const placement = useValue<ReadonlyArray<number>>(store, path) ?? []
  return <PlacementChecks placement={placement} onChange={(next) => store.setValue(path, next)} />
}

function ScriptPlacement({ binding }: { binding: ScriptBinding }) {
  return binding.kind === "store" ? (
    <StorePlacement store={binding.store} path={[...binding.at, "placement"]} />
  ) : (
    <PlacementChecks placement={binding.script.placement} onChange={(placement) => binding.change({ placement })} />
  )
}

/** What a script's two flags make it change, as ST's getRegexedString reads them. */
const effect = (script: RegexScript) =>
  script.markdown_only && script.prompt_only
    ? "Changes what's shown and the prompt sent; the saved message keeps its text."
    : script.markdown_only
      ? "Changes only what's shown; the saved message and the prompt keep its text."
      : script.prompt_only
        ? "Changes only the prompt sent to the model; the saved message keeps its text."
        : "Rewrites messages, including streaming replies. You can still view and restore the original text."

/** A short label of the same, for the script's row. */
const effectBadge = (script: RegexScript) =>
  script.markdown_only && script.prompt_only
    ? "display and prompt"
    : script.markdown_only
      ? "display only"
      : script.prompt_only
        ? "prompt only"
        : "rewrites messages"

const TRY_NAMES = { user: "User", char: "Character" }

/**
 * ST's test mode: the script alone on a sample text, as on a reply, whatever its placement,
 * flags and depths. It runs on the display-regex worker, within its deadline.
 */
function TryIt({ script }: { script: RegexScript }) {
  const [sample, setSample] = useState("")
  const [result, setResult] = useState<{ readonly sample: string; readonly value: DisplayResult } | null>(null)
  useEffect(() => {
    if (sample === "" || script.find_regex === "") return
    let active = true
    const job = {
      text: sample,
      scripts: [{ ...script, disabled: false, markdown_only: true, placement: [2], min_depth: null, max_depth: null }],
      placement: 2,
      depth: null,
      names: TRY_NAMES,
      card: {}
    }
    void Promise.resolve(runRegexJob(job)).then((value) => {
      if (active) setResult({ sample, value })
    })
    return () => {
      active = false
    }
  }, [sample, script])
  const shown = sample !== "" && script.find_regex !== "" && result?.sample === sample ? result.value : null
  return (
    <details className="group rounded-md border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium select-none">Try it</summary>
      <div className="flex flex-col gap-2 border-t border-border p-3">
        <Field
          label="Sample text"
          about="Preview what this script changes in a reply. The test ignores its on/off state, message types and depth limits. {{user}} is “User” and {{char}} is “Character”."
        >
          <Textarea
            rows={3}
            className="resize-y font-mono"
            spellCheck={false}
            value={sample}
            onChange={(event) => setSample(event.currentTarget.value)}
          />
        </Field>
        {shown && (
          <section aria-label="Result" className="flex flex-col gap-1">
            <h4 className="text-sm font-medium">
              Result{shown.text === sample && shown.issues.length === 0 ? " (no match)" : ""}
            </h4>
            <pre className="max-h-60 overflow-auto rounded-md border border-border bg-canvas p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
              {shown.text}
            </pre>
            {shown.issues.map((issue) => (
              <p key={issue} className="text-sm text-warning">
                {issue}
              </p>
            ))}
          </section>
        )}
      </div>
    </details>
  )
}

/** A script's fields, in the same layout whatever holds it. */
function ScriptFields({ binding, script }: { binding: ScriptBinding; script: RegexScript }) {
  return (
    <div className="flex flex-col gap-3">
      <ScriptText binding={binding} field="name" label="Name" />
      <ScriptText binding={binding} field="find_regex" label="Find (a regular expression)" mono />
      <ScriptSubstitute binding={binding} />
      <ScriptText binding={binding} field="replace_string" label="Replace with" rows={2} mono />
      <ScriptLines binding={binding} />
      <ScriptPlacement binding={binding} />
      <Fieldset legend="Leave the saved message as it is, and change only">
        <div className="flex flex-wrap gap-4">
          <ScriptCheck binding={binding} field="markdown_only" label="What's shown" />
          <ScriptCheck binding={binding} field="prompt_only" label="The prompt sent" />
        </div>
        <p className="text-sm text-muted">{effect(script)}</p>
      </Fieldset>
      <ScriptCheck
        binding={binding}
        field="run_on_edit"
        label="Run on edits"
        description="Apply the script when you edit a message too, if both display and prompt options are off."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <ScriptDepth binding={binding} field="min_depth" label="From depth" />
        <ScriptDepth binding={binding} field="max_depth" label="To depth" />
      </div>
      <TryIt script={script} />
    </div>
  )
}

/** One script in a list: on or off, its name and what it changes, opened to edit it. */
export function ScriptItem({
  script,
  name,
  binding,
  open,
  onOpenChange,
  actions
}: {
  script: RegexScript
  name: string
  binding: ScriptBinding
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Under the fields: delete, and moves in a list that orders its scripts. */
  actions: ReactNode
}) {
  const setOn = (on: boolean) =>
    binding.kind === "store"
      ? binding.store.setValue([...binding.at, "disabled"], !on)
      : binding.change({ disabled: !on })
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <Switch checked={!script.disabled} onCheckedChange={setOn}>
            <span className="sr-only">Run {name}</span>
          </Switch>
          <span
            className={`flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium [overflow-wrap:anywhere] ${script.disabled ? "text-muted" : ""}`}
          >
            {name}
            <Badge>{script.disabled ? "off" : effectBadge(script)}</Badge>
          </span>
        </div>
        <Button variant="ghost" aria-expanded={open} aria-label={`Edit ${name}`} onClick={() => onOpenChange(!open)}>
          {open ? "Close" : "Edit"}
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-3">
          <ScriptFields binding={binding} script={script} />
          <div className="flex flex-wrap gap-2">{actions}</div>
        </div>
      )}
    </li>
  )
}

function StoreScript({ store, script }: { store: EditorStore; script: RegexScript }) {
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
    <ScriptItem
      script={script}
      name={name}
      binding={{ kind: "store", store, at }}
      open={open}
      onOpenChange={setOpen}
      actions={
        <Button variant="ghost" hint="Removed when you save." onClick={() => void store.removeItem(at)}>
          Delete the script
        </Button>
      }
    />
  )
}

const APPROVAL_NOTE = {
  preset: "A preset from a file never allows its own scripts.",
  card: "A card from a file never allows its own scripts."
}

/**
 * A preset's or a card's scripts (`regex`) and their approval (`regex_approved`), which only
 * SetRegexApproval changes: drafts never do.
 */
export function DocumentRegexScripts({
  store,
  call,
  holder
}: {
  store: EditorStore
  call: Caller
  holder: "preset" | "card"
}) {
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
    const current = store.value(["regex"]) as ReadonlyArray<RegexScript> | undefined
    const { path, value } = addScriptChange(current, newScript())
    store.setValue(path, value)
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
              <Button
                pending={pending}
                hint="They stop running until you allow them again."
                onClick={() => void setApproval(false)}
              >
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
            <p>{APPROVAL_NOTE[holder]} Read them first: they rewrite text as it's sent and shown.</p>
          </Alert>
        ))}
      {scripts.length === 0 ? (
        <EmptyState title="No regex scripts" />
      ) : (
        <ul aria-label="Regex scripts" className="flex flex-col divide-y divide-border">
          {scripts.map((script) => (
            <StoreScript key={script.id} store={store} script={script} />
          ))}
        </ul>
      )}
      <div>
        <Button hint="A new script, applied to replies and off until you turn it on." onClick={add}>
          Add a script
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Allow ${saved.length === 1 ? "this script" : `these ${saved.length} scripts`} to run?`}
        description="Allow these scripts to change prompts, messages or their display, according to their settings. Later saved edits to the scripts are allowed too."
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

/** The card editor's Regex section (ST's scoped scripts), registered in `cardEditorSections`. */
export function CardRegexScripts({ store, call }: { store: EditorStore; call: Caller }) {
  return (
    <Card>
      <CardHeader title="Regex scripts" />
      <DocumentRegexScripts store={store} call={call} holder="card" />
    </Card>
  )
}
