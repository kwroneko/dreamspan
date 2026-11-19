// Settings → Assistant tools → Subagent types (spec/SUBAGENTS.md §10): the kinds of subagents the
// assistant can start, built in, from plugins and the user's own, with Edit and New type. An edit
// of a built-in or plugin type keeps only what differs from it, and Restore drops it. A type's tools
// are a checklist of what workshops offer; a subagent still never gets a tool its reply wasn't
// offered. The editor is the page's URL (`?type=<id>`, `?type=new`), so it survives a reload.
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState } from "react"
import {
  rowsFor,
  SAME,
  type SubagentToolChoice,
  type SubagentTypeEdit,
  type SubagentTypeView,
  type SubagentTypesView
} from "@dreamspan/shared/subagents.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Field, Fieldset, Input, Textarea } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { SUBAGENT_SETTINGS_KEY, subagentSettingsAtom } from "./SubagentModelsChip.tsx"

const TYPES_KEY = "subagent-types"
const KEYS = ["settings", SUBAGENT_SETTINGS_KEY, TYPES_KEY]

const subagentTypesAtom = AppClient.query("GetSubagentTypes", {}, { reactivityKeys: ["settings", TYPES_KEY] })

/** The id a new type's name suggests: "Check names" → check-names. */
const idFor = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32)

const SOURCE: Record<SubagentTypeView["source"], string> = {
  builtin: "Built in",
  plugin: "From a plugin",
  user: "Yours"
}

const CONTEXTS = [
  { value: "task" as const, label: "Its task", description: "It sees only the task the assistant writes." },
  {
    value: "fork" as const,
    label: "This conversation",
    description: "It sees the conversation up to its start, then its task. It runs on the chat's own model."
  }
]

const FOLDERS = [
  { value: "none" as const, label: "None", description: "It doesn't get a folder to work in." },
  {
    value: "same" as const,
    label: "Your folder",
    description: "It works in the workshop's working folder, alongside the assistant."
  },
  {
    value: "copy" as const,
    label: "Its own copy",
    description:
      "It works in a copy of the working folder (a new branch when it's a Git repository). A copy it didn't change is removed."
  }
]

interface Draft {
  readonly id: string
  readonly label: string
  readonly explanation: string
  readonly description: string
  readonly instructions: string
  readonly tools: ReadonlyArray<string>
  readonly defaultAlias: string
  readonly context: "task" | "fork"
  readonly isolation: "none" | "same" | "copy"
  readonly off: boolean
}

const draftOf = (type: SubagentTypeView | undefined): Draft =>
  type
    ? {
        id: type.id,
        label: type.label,
        explanation: type.explanation,
        description: type.description,
        instructions: type.instructions,
        tools: type.tools,
        defaultAlias: type.defaultAlias,
        context: type.context,
        isolation: type.isolation,
        off: type.off
      }
    : {
        id: "",
        label: "",
        explanation: "",
        description: "",
        instructions: "",
        tools: [],
        defaultAlias: SAME,
        context: "task",
        isolation: "none",
        off: false
      }

function TypeEditor({
  view,
  type,
  aliases,
  close
}: {
  view: SubagentTypesView
  type: SubagentTypeView | undefined
  aliases: ReadonlyArray<string>
  close: () => void
}) {
  const action = useAction()
  const [draft, setDraft] = useState<Draft>(() => draftOf(type))
  const [idTouched, setIdTouched] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)
  const isNew = type === undefined
  const edit = (change: Partial<Draft>) => {
    setInvalid(null)
    setDraft({ ...draft, ...change })
  }
  const change = (edit: SubagentTypeEdit | null) =>
    action.run((client) => client("ChangeSubagentType", { id: type?.id ?? draft.id, edit }), KEYS)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const id = draft.id.trim()
    if (isNew && !/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
      setInvalid("The id is one lower-case word of letters, digits, - or _, starting with a letter.")
      return
    }
    if (isNew && view.types.some((t) => t.id === id)) {
      setInvalid(`There's already a type “${id}”.`)
      return
    }
    if (!draft.label.trim() || !draft.instructions.trim()) {
      setInvalid("A type needs a name and instructions.")
      return
    }
    const result = await action.run(
      (client) =>
        client("ChangeSubagentType", {
          id,
          edit: {
            id,
            label: draft.label.trim(),
            explanation: draft.explanation.trim(),
            description: draft.description.trim(),
            instructions: draft.instructions.trim(),
            tools: [...draft.tools],
            defaultAlias: draft.defaultAlias,
            context: draft.context,
            isolation: draft.isolation,
            ...(draft.off ? { off: true } : {})
          }
        }),
      KEYS
    )
    if (result.ok) close()
  }
  const toggle = (tool: SubagentToolChoice, on: boolean) =>
    edit({ tools: on ? [...draft.tools, tool.id] : draft.tools.filter((t) => t !== tool.id) })
  const groups = [
    { title: "Reading", tools: view.tools.filter((t) => t.effect === "read") },
    { title: "Changing", tools: view.tools.filter((t) => t.effect !== "read") }
  ].filter((g) => g.tools.length > 0)
  const aliasItems = [...new Set([SAME, ...aliases, draft.defaultAlias])].map((alias) => ({
    value: alias,
    label: alias === SAME ? "same (the chat's model)" : alias
  }))
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
      data-subagent-type-editor={type?.id ?? "new"}
    >
      <h3 className="text-base font-medium text-text">{isNew ? "New subagent type" : `Edit “${type.label}”`}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" about="Shown in a subagent's row.">
          <Input
            name="label"
            value={draft.label}
            maxLength={60}
            onChange={(event) => {
              const label = event.currentTarget.value
              edit(isNew && !idTouched ? { label, id: idFor(label) } : { label })
            }}
          />
        </Field>
        <Field
          label="Id"
          about="The word the assistant writes to start this type."
          {...(isNew ? {} : { description: "A type keeps its id." })}
        >
          <Input
            name="id"
            value={draft.id}
            maxLength={32}
            disabled={!isNew}
            onChange={(event) => {
              setIdTouched(true)
              edit({ id: event.currentTarget.value })
            }}
          />
        </Field>
      </div>
      <Field label="In short" about="Shown when you hover a subagent of this type.">
        <Input
          name="explanation"
          value={draft.explanation}
          maxLength={200}
          onChange={(event) => edit({ explanation: event.currentTarget.value })}
        />
      </Field>
      <Field label="What it's for" about="The assistant reads this when it chooses a type.">
        <Textarea
          name="description"
          value={draft.description}
          maxLength={600}
          rows={2}
          onChange={(event) => edit({ description: event.currentTarget.value })}
        />
      </Field>
      <Field label="Instructions" about="The subagent's own instructions, before its task.">
        <Textarea
          name="instructions"
          value={draft.instructions}
          maxLength={20_000}
          rows={8}
          onChange={(event) => edit({ instructions: event.currentTarget.value })}
        />
      </Field>
      <Fieldset
        legend="Tools"
        about="What it may use. A subagent never gets a tool its reply wasn't offered, nor one turned off in the workshop."
        description={`${draft.tools.length} picked`}
      >
        <div className="flex flex-col gap-3" data-subagent-type-tools="">
          {groups.map((group) => (
            <div key={group.title} className="flex flex-col gap-1">
              <p className="text-sm text-muted">{group.title}</p>
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {group.tools.map((tool) => (
                  <Checkbox
                    key={tool.id}
                    checked={draft.tools.includes(tool.id)}
                    onCheckedChange={(on) => toggle(tool, on)}
                    hint={tool.explanation}
                    hintInline={false}
                  >
                    {tool.label}
                  </Checkbox>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Model" about="The model it runs on when the assistant names none, if that model is picked.">
          <Select
            items={aliasItems}
            value={draft.defaultAlias}
            onValueChange={(value) => edit({ defaultAlias: value })}
          />
        </Field>
        <Segmented
          label="It sees"
          options={CONTEXTS}
          value={draft.context}
          onValueChange={(value) => edit({ context: value })}
        />
      </div>
      <Segmented
        label="Works in"
        options={FOLDERS}
        value={draft.isolation}
        onValueChange={(value) => edit({ isolation: value })}
      />
      {!isNew && type.source !== "user" && (
        <Checkbox
          checked={!draft.off}
          onCheckedChange={(on) => edit({ off: !on })}
          hint="Unticked, the assistant can't start this type."
        >
          Offer this type
        </Checkbox>
      )}
      {invalid && <Alert tone="danger">{invalid}</Alert>}
      <ErrorAlert error={action.error} title="Not saved" />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" variant="primary" hint="Saves this type for every workshop." pending={action.pending}>
          Save
        </Button>
        <Button variant="ghost" hint="Closes the editor without saving." onClick={close}>
          Cancel
        </Button>
        {type?.edited && type.source !== "user" && (
          <Button
            variant="ghost"
            hint="Drops your changes: the type is as it came again."
            onClick={() => void change(null).then((r) => r.ok && close())}
          >
            Restore
          </Button>
        )}
        {type?.source === "user" && (
          <Button
            variant="danger"
            hint="Deletes this type. Subagents it already started keep their runs."
            onClick={() => void change(null).then((r) => r.ok && close())}
          >
            Delete type
          </Button>
        )}
      </div>
    </form>
  )
}

function TypeRow({ type, open }: { type: SubagentTypeView; open: () => void }) {
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-start" data-subagent-type={type.id}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-text [overflow-wrap:anywhere]">{type.label}</span>
          <Badge size="sm">{SOURCE[type.source]}</Badge>
          {type.edited && type.source !== "user" && <Badge size="sm">Edited</Badge>}
          {type.off && (
            <Badge size="sm" tone="warning">
              Off
            </Badge>
          )}
        </span>
        <span className="text-sm text-muted [overflow-wrap:anywhere]">{type.description}</span>
        <span className="text-sm text-muted">
          {type.id} · {type.tools.length === 1 ? "1 tool" : `${type.tools.length} tools`} · Model: {type.defaultAlias} ·
          Sees: {type.context === "fork" ? "this conversation" : "its task"}
        </span>
      </div>
      <Button hint="Changes this type's instructions, tools and model." onClick={open}>
        Edit
      </Button>
    </li>
  )
}

export function SubagentTypesSection() {
  const result = useAtomValue(subagentTypesAtom)
  const settingsResult = useAtomValue(subagentSettingsAtom)
  const view = AsyncResult.isSuccess(result) ? result.value : undefined
  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : undefined
  const [editing, setEditing] = usePlaceParam("type", "")
  const aliases = settings ? [...rowsFor(settings.models, settings.models.picks).values()].map((row) => row.alias) : []
  const type = view?.types.find((t) => t.id === editing)
  const close = () => setEditing("")
  return (
    <Card>
      <CardHeader
        title="Subagent types"
        about="The kinds of subagents the assistant can start, each with its own instructions and tools. A subagent never has tools its reply doesn't."
      />
      {!view ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : editing === "new" || type ? (
        <TypeEditor
          key={editing}
          view={view}
          type={editing === "new" ? undefined : type}
          aliases={aliases}
          close={close}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {editing !== "" && <Alert tone="warning">That type is gone. Showing the list.</Alert>}
          <ul className="flex flex-col divide-y divide-border" data-subagent-types="">
            {view.types.map((t) => (
              <TypeRow key={t.id} type={t} open={() => setEditing(t.id)} />
            ))}
          </ul>
          <div>
            <Button hint="Adds a kind of subagent of your own." onClick={() => setEditing("new")}>
              New type
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
