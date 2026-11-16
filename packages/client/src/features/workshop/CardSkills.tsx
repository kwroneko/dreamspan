// The card editor's Skills section (spec/TOOL-LOADING.md §6): the skills a workshop assistant
// speaking as this card can load, kept in `extensions.rp_harness.skills`. Editing them here is
// not approval: the server asks the user before a card's skill reaches the model, whatever the
// text says. Each entry shows why the server would skip or shorten it (`cardSkillProblems`).
import {
  CARD_SKILL_LIMITS,
  CARD_SKILLS_NAMESPACE,
  cardSkillList,
  cardSkillProblems,
  duplicateSkillNames,
  isSkillReference
} from "@rp/shared/cardSkills.ts"
import { valueField } from "@rp/shared/editing.ts"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input, Textarea } from "../../ui/Field.tsx"
import { ContextMenu, MenuItem } from "../../ui/Menu.tsx"
import { SortableList } from "../../ui/SortableList.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { FieldTools } from "../editor/controls.tsx"
import { type EditorStore, useValue } from "../editor/store.ts"

const PATH = ["extensions", CARD_SKILLS_NAMESPACE]
const FIELD = valueField(PATH)

type Entry = Readonly<Record<string, unknown>>
interface Draft {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly tools: string
}

const str = (value: unknown) => (typeof value === "string" ? value : "")
const draftOf = (entry: Entry | null): Draft => ({
  name: str(entry?.name),
  description: str(entry?.description),
  instructions: str(entry?.instructions),
  tools: Array.isArray(entry?.tools) ? entry.tools.filter((t) => typeof t === "string").join(", ") : ""
})
const entryOf = (draft: Draft, before: Entry | null): Entry => ({
  ...before,
  name: draft.name.trim(),
  description: draft.description.trim(),
  instructions: draft.instructions,
  tools: draft.tools
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "")
})
const isReference = isSkillReference
const labelOf = (entry: unknown) =>
  isReference(entry) ? entry.use : str((entry as Entry | null)?.name) || "Unnamed skill"

function SkillDialog({
  open,
  onOpenChange,
  entry,
  onSave
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The skill being edited; null adds one. */
  entry: Entry | null
  onSave: (entry: Entry) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(entry))
  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }))
  const problems = cardSkillProblems(entryOf(draft, null), 0)
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={entry ? `Edit ${labelOf(entry)}` : "Add a skill"}
      description="The assistant sees only the name until you allow it to load the skill."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          onSave(entryOf(draft, entry))
          onOpenChange(false)
        }}
      >
        <Field
          label="Name"
          about="What the assistant asks for, such as proofread. Lower-case letters, digits, - and _."
        >
          <Input
            value={draft.name}
            maxLength={CARD_SKILL_LIMITS.name}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => set("name")(event.currentTarget.value)}
          />
        </Field>
        <Field label="What it's for" about="Shown to you when the assistant asks to load it.">
          <Textarea
            rows={2}
            value={draft.description}
            onChange={(event) => set("description")(event.currentTarget.value)}
          />
        </Field>
        <Field label="Instructions" about="What the assistant is told once you allow the skill.">
          <Textarea
            rows={8}
            value={draft.instructions}
            onChange={(event) => set("instructions")(event.currentTarget.value)}
          />
        </Field>
        <Field
          label="Tools"
          about="Tool names the skill makes available, separated by commas. Tools you haven't allowed stay unavailable."
        >
          <Input
            value={draft.tools}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => set("tools")(event.currentTarget.value)}
          />
        </Field>
        {problems.length > 0 && (
          <ul aria-label="Problems" className="flex flex-col gap-1 text-sm text-warning">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <DialogActions>
          <Button hint="Closes without changing the skill." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" hint="Saves the skill to this card.">
            {entry ? "Save" : "Add"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function SkillRow({
  entry,
  index,
  count,
  duplicate,
  handle,
  onEdit,
  onMove,
  onRemove
}: {
  entry: unknown
  index: number
  count: number
  duplicate: boolean
  handle: React.ReactNode
  onEdit: () => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const [menu, setMenu] = useState(false)
  const reference = isReference(entry)
  const name = labelOf(entry)
  const problems = [
    ...cardSkillProblems(entry, index),
    ...(duplicate ? ["Another skill here has this name: neither is offered."] : [])
  ]
  return (
    <div className="flex min-w-0 items-start gap-2 py-2">
      {handle}
      <ContextMenu
        label={`Actions for skill ${name}`}
        open={menu}
        onOpenChange={setMenu}
        trigger={
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 font-mono text-sm font-medium [overflow-wrap:anywhere]">{name}</span>
              {reference && <Badge>reference</Badge>}
            </span>
            <span className="line-clamp-2 text-sm text-muted [overflow-wrap:anywhere]">
              {reference
                ? "Offers the installed skill with this name, if there is one."
                : str((entry as Entry | null)?.description) || "No description"}
            </span>
            {problems.map((p) => (
              <span key={p} className="text-sm text-warning">
                {p}
              </span>
            ))}
          </div>
        }
      >
        {!reference && (
          <MenuItem icon="edit" description="Changes its name, description, instructions or tools." onClick={onEdit}>
            Edit
          </MenuItem>
        )}
        <MenuItem
          icon="move-up"
          description="Moves it up the list."
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        >
          Move up
        </MenuItem>
        <MenuItem
          icon="move-down"
          description="Moves it down the list."
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          Move down
        </MenuItem>
        <MenuItem icon="trash" tone="danger" description="Removes it from this card." onClick={onRemove}>
          Remove
        </MenuItem>
      </ContextMenu>
      <div className="flex shrink-0 gap-1">
        {!reference && (
          <IconButton
            icon="edit"
            label={`Edit ${name}`}
            hint="Changes its name, description, instructions or tools."
            onClick={onEdit}
          />
        )}
        <IconButton
          icon="trash"
          tone="danger"
          label={`Remove ${name}`}
          hint="Removes it from this card."
          onClick={onRemove}
        />
      </div>
    </div>
  )
}

/** Registered in `cardEditorSections` (Extra tab). */
export function CardSkills({ store }: { store: EditorStore }) {
  const ours = useValue<Entry | undefined>(store, PATH)
  const extensions = useValue<Entry | undefined>(store, ["extensions"])
  const list = cardSkillList(extensions)
  const duplicates = duplicateSkillNames(list)
  // null: closed; "new": adding; a number: editing that entry.
  const [editing, setEditing] = useState<number | "new" | null>(null)
  const write = (next: ReadonlyArray<unknown>) => {
    const { skills: _skills, ...rest } = ours && typeof ours === "object" ? ours : {}
    store.setValue(PATH, next.length === 0 ? rest : { ...rest, skills: next })
  }
  const move = (from: number, to: number) => {
    const next = [...list]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    write(next)
  }
  // A key that stays with its entry as it moves (its name, numbered among entries of that name),
  // so the handle keeps the focus and the arrows can move an entry more than one place.
  const seen = new Map<string, number>()
  const keys = list.map((entry) => {
    const name = `${isReference(entry) ? "use" : "own"}:${labelOf(entry)}`
    const nth = seen.get(name) ?? 0
    seen.set(name, nth + 1)
    return `${name}:${nth}`
  })
  const current = typeof editing === "number" ? ((list[editing] as Entry | undefined) ?? null) : null
  return (
    <Card>
      <CardHeader
        title="Skills"
        about="Skills a workshop assistant speaking as this card can load. The assistant sees only their names; it asks you before loading one, and shows you its instructions first. A skill is left out when an installed skill has its name, or when it lists tools and none of them is available in the workshop."
        actions={
          <Button hint="Writes a new skill for this card." onClick={() => setEditing("new")}>
            Add a skill
          </Button>
        }
      />
      <div className="flex flex-col gap-2">
        {list.length === 0 ? (
          <EmptyState title="No skills" />
        ) : (
          <SortableList
            items={list.map((entry, index) => ({ entry, index, key: keys[index]! }))}
            itemKey={(item) => item.key}
            itemLabel={(item) => labelOf(item.entry)}
            label="Skills"
            onMove={move}
          >
            {(item, handle) => (
              <SkillRow
                entry={item.entry}
                index={item.index}
                count={list.length}
                duplicate={!isReference(item.entry) && duplicates.has(str((item.entry as Entry).name).trim())}
                handle={handle}
                onEdit={() => setEditing(item.index)}
                onMove={(to) => move(item.index, to)}
                onRemove={() => write(list.filter((_, i) => i !== item.index))}
              />
            )}
          </SortableList>
        )}
        <FieldTools store={store} field={FIELD} label="Skills" />
      </div>
      {editing !== null && (
        <SkillDialog
          key={String(editing)}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          entry={current}
          onSave={(entry) =>
            write(typeof editing === "number" ? list.map((e, i) => (i === editing ? entry : e)) : [...list, entry])
          }
        />
      )}
    </Card>
  )
}
