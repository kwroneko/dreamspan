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
import { Checkbox } from "../../ui/Choice.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { Field, Fieldset, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { LinesField, NumberField, SelectField, SwitchField, TextField } from "./controls.tsx"
import { SearchNavigation } from "./searchNavigation.ts"
import { type EditorStore, useEditorState, useText, useValue } from "./store.ts"

const PLACEMENTS = [
  [1, "Your messages"],
  [2, "Replies"],
  [3, "Slash commands"],
  [5, "Lorebook entries"],
  [6, "Reasoning"]
] as const

const SUBSTITUTIONS: ReadonlyArray<{ readonly value: RegexScript["substitute_regex"]; readonly label: string }> = [
  { value: "none", label: "Not expanded" },
  { value: "raw", label: "Expanded" },
  { value: "escaped", label: "Expanded, with regex characters escaped" }
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

function ScriptCheck({ binding, field, label }: { binding: ScriptBinding; field: CheckKey; label: string }) {
  if (binding.kind === "store")
    return <SwitchField store={binding.store} path={[...binding.at, field]} label={label} checkbox />
  return (
    <Checkbox checked={binding.script[field]} onCheckedChange={(checked) => binding.change({ [field]: checked })}>
      {label}
    </Checkbox>
  )
}

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
    <Field label={label}>
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
    <NumberField store={binding.store} path={[...binding.at, field]} label={label} nullable integer />
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
      <div className="flex flex-wrap gap-4">
        {PLACEMENTS.map(([value, label]) => (
          <Checkbox
            key={value}
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

/** A script's fields, in the same layout whatever holds it. */
function ScriptFields({ binding }: { binding: ScriptBinding }) {
  return (
    <div className="flex flex-col gap-3">
      <ScriptText binding={binding} field="name" label="Name" />
      <ScriptText binding={binding} field="find_regex" label="Find (a regular expression)" mono />
      <ScriptSubstitute binding={binding} />
      <ScriptText binding={binding} field="replace_string" label="Replace with" rows={2} mono />
      <ScriptLines binding={binding} />
      <ScriptPlacement binding={binding} />
      <div className="flex flex-wrap gap-4">
        <ScriptCheck binding={binding} field="disabled" label="Off" />
        <ScriptCheck binding={binding} field="prompt_only" label="Only in the prompt" />
        <ScriptCheck binding={binding} field="markdown_only" label="Only in what's shown" />
        <ScriptCheck binding={binding} field="run_on_edit" label="Run on edits" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ScriptDepth binding={binding} field="min_depth" label="From depth (empty: any)" />
        <ScriptDepth binding={binding} field="max_depth" label="To depth (empty: any)" />
      </div>
    </div>
  )
}

/** One script in a list: its name and flags, opened to edit it. */
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
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
          {name}
          {script.disabled && <Badge>off</Badge>}
          {script.prompt_only && <Badge>prompt only</Badge>}
          {script.markdown_only && <Badge>display only</Badge>}
        </span>
        <Button variant="ghost" aria-expanded={open} aria-label={`Edit ${name}`} onClick={() => onOpenChange(!open)}>
          {open ? "Close" : "Edit"}
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-3">
          <ScriptFields binding={binding} />
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
        <Button variant="ghost" onClick={() => void store.removeItem(at)}>
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
    const script = newScript()
    store.setValue(["regex", `id=${script.id}`], script)
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
        <Button onClick={add}>Add a script</Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Allow ${saved.length === 1 ? "this script" : `these ${saved.length} scripts`} to run?`}
        description="They'll rewrite text in the prompt, in messages as they're saved and on screen as their patterns say. Unsaved changes to them are allowed too once saved."
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
      <CardHeader
        title="Regex scripts"
        description="Run on this card's messages, after your global scripts and the preset's. Changes are drafts until you save the card."
      />
      <DocumentRegexScripts store={store} call={call} holder="card" />
    </Card>
  )
}
