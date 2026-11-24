// The model settings form's controls: a number set by slider or typed, bounded by a limit the
// user can override in place; and a list of rows (stop strings, parameters) to add to.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { AboutHint, LabelWithHelp } from "../../ui/AboutHint.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field, Fieldset, Input } from "../../ui/Field.tsx"
import { FieldSlider, type SliderScale } from "../../ui/Slider.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import type { Row } from "./modelForm.ts"

const numberText = (n: number) => n.toLocaleString()

/** A headed group of the form, named by its title, with its help in a "?". */
export function Group({
  title,
  about,
  children,
  className = ""
}: {
  title: string
  about?: string
  children: ReactNode
  className?: string
}) {
  return (
    <Fieldset
      legend={<span className="text-base font-semibold">{title}</span>}
      aboutLabel={title}
      about={about}
      className={`gap-4 border-t border-border pt-4 ${className}`}
    >
      {children}
    </Fieldset>
  )
}

/** The model's limit at a slider's end: its figure, where it came from, and the pencil to set your own. */
export interface Limit {
  /** "context limit" */
  readonly name: string
  readonly value: number
  /** Where the figure comes from, for its "?". */
  readonly source: string
  /** Nobody reports it: the figure is a guess, marked so. */
  readonly assumed: boolean
  /** The user's own limit as typed; empty uses the reported one. */
  readonly own: string
  readonly onOwn: (text: string) => void
  readonly problem: string | null
  /** Open from the start: a link asked for this field. */
  readonly open: boolean
  readonly field: string
}

function LimitEnd({ limit }: { limit: Limit }) {
  const [editing, setEditing] = useState(limit.open)
  const open = editing || limit.own !== ""
  const input = useRef<HTMLInputElement>(null)
  const focusing = useRef(false)
  useEffect(() => {
    if (!open || !focusing.current) return
    focusing.current = false
    input.current?.focus()
  }, [open])
  return (
    <div className="flex min-w-0 flex-col items-end gap-2" data-limit={limit.field}>
      <span className="flex items-center gap-1 text-xs text-muted">
        <LabelWithHelp help={<AboutHint heading={capitalized(limit.name)}>{limit.source}</AboutHint>}>
          <span className={`tabular-nums ${limit.assumed ? "text-warning" : ""}`}>
            Max {numberText(limit.value)}
            {limit.assumed ? " (assumed)" : ""}
          </span>
        </LabelWithHelp>
        <IconButton
          icon="edit"
          // The help mark's small square beside it, as a compact rename pencil is: one even pair.
          className="size-5! [&_svg]:size-3!"
          label={`Set the ${limit.name} yourself`}
          hint={
            open
              ? "This limit is already open for editing."
              : `Set the ${limit.name} yourself, if the reported one is wrong.`
          }
          disabled={open}
          focusableWhenDisabled
          onClick={() => {
            focusing.current = true
            setEditing(true)
          }}
        />
      </span>
      {open && (
        <div className="flex min-w-0 flex-wrap items-end justify-end gap-2">
          <Field label={`Your ${limit.name} (tokens)`} error={limit.problem} className="w-40">
            <Input
              ref={input}
              value={limit.own}
              onValueChange={limit.onOwn}
              inputMode="numeric"
              data-model-field={limit.field}
              placeholder={String(limit.value)}
            />
          </Field>
          <Button
            variant="ghost"
            hint="Clears your limit, so what the provider reports applies again."
            onClick={() => {
              limit.onOwn("")
              setEditing(false)
            }}
          >
            Use reported
          </Button>
        </div>
      )}
    </div>
  )
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * A number set with a slider or typed exactly beside it. Empty uses the default the slider then
 * shows. `limit` puts the model's limit at the slider's end, with its own override.
 */
export function RangeField({
  label,
  about,
  field,
  text,
  value,
  fallback,
  placeholder,
  min,
  max,
  step,
  whole = false,
  scale = "linear",
  limit,
  note,
  error,
  onText,
  onSlide
}: {
  label: string
  about: string
  field: string
  /** The field's text: as typed, or the value set. */
  text: string
  /** The value set; null uses `fallback`. */
  value: number | null
  fallback: number
  placeholder?: string
  min: number
  max: number
  step: number
  whole?: boolean
  /** "log" for a range over orders of magnitude (token counts): see the ui Slider. */
  scale?: SliderScale
  limit?: Limit
  /** A short tag after the label ("not sent"), with its explanation. */
  note?: { readonly text: string; readonly hint: string } | undefined
  error?: string | null
  onText: (text: string) => void
  /** A slide to a value; null when it reaches the end that means the default. */
  onSlide: (value: number) => void
}) {
  const shown = value ?? fallback
  const format = (n: number) => (whole ? numberText(n) : String(n))
  return (
    <div className="flex max-w-xl min-w-0 flex-col gap-1.5" data-range={field}>
      <Field
        label={label}
        about={about}
        error={error}

        labelEnd={
          <div className="flex items-center gap-1">
            {note && (
              <Tooltip label={note.hint}>
                <span
                  tabIndex={0}
                  className="rounded-sm text-xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {note.text}
                </span>
              </Tooltip>
            )}
            <Input
              value={text}
              onValueChange={onText}
              inputMode={whole ? "numeric" : "decimal"}
              placeholder={placeholder ?? format(fallback)}
              data-model-field={field}
              className="w-28 text-right tabular-nums"
            />
            <IconButton
              icon="undo"
              label={`Use the default ${label.toLowerCase()}`}
              hint={
                value === null && text === "" ? "Already the default." : `Back to the default: ${format(fallback)}.`
              }
              disabled={value === null && text === ""}
              focusableWhenDisabled
              onClick={() => onText("")}
            />
          </div>
        }
      >
        {null}
      </Field>
      <FieldSlider
        label={`${label} slider`}
        value={shown}
        min={min}
        max={Math.max(min + step, max)}
        step={step}
        largeStep={whole ? Math.max(step, Math.round((max - min) / 20 / step) * step) : step * 10}
        valueText={format}
        scale={scale}
        onValueChange={onSlide}
      />
      {limit && (
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <span className="text-xs text-muted tabular-nums">{format(min)}</span>
          <LimitEnd limit={limit} />
        </div>
      )}
    </div>
  )
}

/**
 * Rows to add to and remove: one text each (`value` only), or a name and a value. `tag` reads a
 * row's value out ("number"), so a typed parameter shows what it'll be sent as.
 */
export function RowsEditor({
  label,
  about,
  rows,
  onRows,
  name,
  value,
  add,
  tag,
  field
}: {
  label: string
  about: string
  rows: ReadonlyArray<Row>
  onRows: (rows: ReadonlyArray<Row>) => void
  /** The name column's label, or none for a list of single values. */
  name?: { readonly label: string; readonly placeholder?: string }
  value: { readonly label: string; readonly placeholder?: string; readonly numeric?: boolean }
  add: string
  tag?: (row: Row) => string | null
  field: string
}) {
  const change = (index: number, row: Partial<Row>) =>
    onRows(rows.map((entry, i) => (i === index ? { ...entry, ...row } : entry)))
  return (
    <Fieldset legend={label} about={about} aboutLabel={label} className="max-w-xl gap-2">
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label={label} data-rows={field}>
          {rows.map((row, index) => (
            <li
              key={index}
              className={`grid items-center gap-2 ${name ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]"}`}
            >
              {name && (
                <Field label={`${name.label} ${index + 1}`} labelHidden>
                  <Input
                    value={row.name}
                    onValueChange={(text) => change(index, { name: text })}
                    placeholder={name.placeholder}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
              )}
              <Field label={`${value.label} ${index + 1}`} labelHidden>
                <Input
                  value={row.value}
                  onValueChange={(text) => change(index, { value: text })}
                  placeholder={value.placeholder}
                  inputMode={value.numeric ? "decimal" : undefined}
                  autoCapitalize="none"
                  spellCheck={false}
                  status={tag?.(row) ?? undefined}
                />
              </Field>
              <IconButton
                icon="close"
                label={`Remove ${label.toLowerCase()} ${index + 1}`}
                hint="Removes this row."
                onClick={() => onRows(rows.filter((_, i) => i !== index))}
              />
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="ghost"
        className="self-start"
        hint={`Adds an empty row to ${label.toLowerCase()}.`}
        onClick={() => onRows([...rows, { name: "", value: "" }])}
      >
        {add}
      </Button>
    </Fieldset>
  )
}
