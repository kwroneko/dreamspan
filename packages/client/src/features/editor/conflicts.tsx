// The per-field conflict picker (DESIGN §4): for each field both sides changed, keep one
// side, or edit the text into what it should be.
import { type FieldPath, withValues } from "@rp/shared/editing.ts"
import type { Doc } from "@rp/shared/library.ts"
import { useId } from "react"
import { RadioGroup } from "../../ui/Choice.tsx"
import { Field, Textarea } from "../../ui/Field.tsx"
import { ValueDiff } from "./diff.tsx"

export type Choice = { readonly side: "mine" | "theirs" } | { readonly side: "edit"; readonly text: string }

export interface Conflict {
  readonly key: string
  readonly label: string
  readonly mine: unknown
  readonly theirs: unknown
  /** What both started from, when known. */
  readonly base?: unknown
}

const asEditable = (value: unknown) =>
  typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2)

/** The value a choice stands for; an edit of a non-text value is JSON, or undefined if it isn't valid. */
export const chosen = (conflict: Conflict, choice: Choice): unknown => {
  if (choice.side !== "edit") return choice.side === "mine" ? conflict.mine : conflict.theirs
  if (typeof conflict.mine === "string" || typeof conflict.theirs === "string") return choice.text
  try {
    return JSON.parse(choice.text) as unknown
  } catch {
    return undefined
  }
}

/**
 * The merged document with each conflict as the user chose it. A side without a value there
 * deleted it, so taking that side deletes it too. Null if a choice isn't valid or doesn't fit.
 */
export const resolution = (
  merged: Doc,
  paths: ReadonlyArray<FieldPath>,
  conflicts: ReadonlyArray<Conflict>,
  choices: ReadonlyArray<Choice>
) => {
  const values = paths.map((path, index) => ({ path, value: chosen(conflicts[index]!, choices[index]!) }))
  // An edit that isn't valid JSON is undefined too, and must not delete the field.
  const invalid = values.some(({ value }, index) => value === undefined && choices[index]!.side === "edit")
  return invalid ? null : withValues(merged, values)
}

const shown = (value: unknown) => (value === undefined ? "(removed)" : asEditable(value))

export function ConflictPicker({
  conflict,
  choice,
  onChoice,
  mineLabel,
  theirsLabel
}: {
  conflict: Conflict
  choice: Choice
  onChoice: (choice: Choice) => void
  mineLabel: string
  theirsLabel: string
}) {
  const legend = useId()
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <p id={legend} className="text-sm font-medium [overflow-wrap:anywhere]">
        {conflict.label}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted">{mineLabel}</span>
          <pre className="max-h-48 overflow-auto rounded-md border border-border bg-canvas p-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {shown(conflict.mine)}
          </pre>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted">{theirsLabel}</span>
          <pre className="max-h-48 overflow-auto rounded-md border border-border bg-canvas p-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {shown(conflict.theirs)}
          </pre>
        </div>
      </div>
      {conflict.base !== undefined && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">How each side changed it</summary>
          <div className="mt-2 flex flex-col gap-2">
            <span className="text-xs text-muted">{mineLabel}</span>
            <ValueDiff before={conflict.base} after={conflict.mine} />
            <span className="text-xs text-muted">{theirsLabel}</span>
            <ValueDiff before={conflict.base} after={conflict.theirs} />
          </div>
        </details>
      )}
      <RadioGroup
        aria-labelledby={legend}
        value={choice.side}
        onValueChange={(side) =>
          onChoice(
            side === "edit"
              ? { side, text: asEditable(choice.side === "theirs" ? conflict.theirs : conflict.mine) }
              : { side }
          )
        }
        options={[
          { value: "mine", label: `Keep ${mineLabel.toLowerCase()}` },
          { value: "theirs", label: `Take ${theirsLabel.toLowerCase()}` },
          { value: "edit", label: "Edit it" }
        ]}
      />
      {choice.side === "edit" && (
        <Field label={`${conflict.label}, edited`}>
          <Textarea
            rows={6}
            value={choice.text}
            onChange={(event) => onChoice({ side: "edit", text: event.currentTarget.value })}
          />
        </Field>
      )}
    </li>
  )
}
