// Form controls bound to an editor's fields: each reads its own field from the store and
// writes it as a draft, so every change is on the server within a second, with its history.
import { EditHistory, type Loaded } from "../../ui/EditHistory.tsx"
import { type FieldPath, parseField, textField, valueField } from "@rp/shared/editing.ts"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Fieldset, Input, Textarea } from "../../ui/Field.tsx"
import { Select, type SelectItem } from "../../ui/Select.tsx"
import { chromeButton } from "../../ui/FieldFrame.tsx"
import { Alert, Badge } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { scrollToSearchField, useSearchMatch } from "./searchNavigation.ts"
import { ReplayNotice } from "./ReplayNotice.tsx"
import { CardTextEditor } from "./CardTextEditor.tsx"
import type { CallResult } from "./caller.ts"
import { draftLabel } from "./fields.ts"
import { type EditorStore, useDirty, useEditorKind, useEditorState, useHasHistory, useText, useValue } from "./store.ts"

/**
 * A field's label. A setting shows "edited" while
 * it has changes; a text field shows that in its box's strip instead (`FieldStatus`).
 */
function FieldLabel({ store, field, label }: { store?: EditorStore; field?: string; label: string }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span>{label}</span>
      {store && field !== undefined && <DirtyBadge store={store} field={field} />}
    </span>
  )
}

function DirtyBadge({ store, field }: { store: EditorStore; field: string }) {
  return useDirty(store, field) ? <Badge tone="accent">edited</Badge> : null
}

/**
 * At the start of a text field's strip inside its box (ui/FieldFrame.tsx; owner, 2026-11-02):
 * "edited" while it has changes, and `aside` (its token count, say).
 */
function FieldStatus({ store, field, aside }: { store: EditorStore; field: string; aside?: ReactNode }) {
  return (
    <>
      <DirtyBadge store={store} field={field} />
      {aside}
    </>
  )
}

/** What a store call gave, as `ui/EditHistory` takes it. */
const loaded = <A,>(result: CallResult<A>): Loaded<A> =>
  result.ok ? { ok: true, value: result.value } : { ok: false, error: { message: result.error.message } }

/**
 * A text field's edit history control (`ui/EditHistory`, owner 2026-11-01): every state it had,
 * from any device, past its revisions; picking one puts it in the box as the newest state.
 * Shown once the field was typed into. The box's own Ctrl+Z is the everyday undo.
 */
function FieldEditHistory({
  store,
  field,
  label,
  reserve = false
}: {
  store: EditorStore
  field: string
  label: string
  /** In a box's strip: its room is kept before there's any history, so what's beside it never moves. */
  reserve?: boolean
}) {
  const has = useHasHistory(store, field)
  const load = useCallback(async (before?: number) => loaded(await store.history(field, 50, before)), [store, field])
  const read = useCallback(async (seq: number) => loaded(await store.stateText(field, seq)), [store, field])
  const restore = useCallback(async (seq: number) => loaded(await store.restore(field, seq)), [store, field])
  if (!has) return reserve ? <span aria-hidden="true" className={`shrink-0 ${chromeButton}`} /> : null
  return <EditHistory label={label} load={load} read={read} restore={restore} className={chromeButton} />
}

/**
 * Beside a field: a text field's edit history, and a copy from this browser that went over
 * another tab's text. Settings (values) have neither Undo nor History of their own (owner,
 * 2026-11-01): they apply as changed, and History shows them in its revisions. `TextField` puts
 * the edit history in its box's strip instead (`history={false}` here).
 */
export function FieldTools({
  store,
  field,
  label,
  history = true
}: {
  store: EditorStore
  field: string
  label: string
  history?: boolean
}) {
  const conflict = useSyncExternalStore(store.subscribe(field), () => store.conflict(field))
  const text = history && parseField(field)?.kind === "text"
  if (!text && conflict === null) return null
  return (
    <div className="flex flex-col gap-1">
      {conflict && (
        <ReplayNotice
          conflict={conflict}
          acknowledge={() => store.acknowledgeConflict(field)}
          switchText={() => store.switchConflict(field)}
        />
      )}
      {text && (
        <div className="flex flex-wrap justify-end gap-1">
          <FieldEditHistory store={store} field={field} label={label} />
        </div>
      )}
    </div>
  )
}

/** A text field. Long ones are textareas; `mono` for patterns. */
export function TextField({
  store,
  path,
  label,
  rows,
  about,
  description,
  mono = false,
  readOnly = false,
  labelHidden = false,
  fit = false,
  source,
  hint,
  aside,
  autoFocus,
  flash
}: {
  store: EditorStore
  path: FieldPath
  label: string
  rows?: number
  about?: ReactNode
  description?: ReactNode
  /** Help beside the label; alias retained for card text fields. */
  hint?: ReactNode
  /** At the start of the strip inside the box, after "edited": the field's token count, say. */
  aside?: ReactNode
  mono?: boolean
  readOnly?: boolean
  /** The label is for assistive technology only (a prompt's text, named in its block's header). */
  labelHidden?: boolean
  /** A textarea as tall as its text, from `rows` up, instead of `rows` high: text read in a list. */
  fit?: boolean
  /** A snippet's own text: its editor offers no sending to a snippet. */
  source?: "snippet" | undefined
  /** Focused as it mounts: a prompt just added, ready to type. */
  autoFocus?: boolean
  /** Text just added (a snippet's sent text), marked briefly and scrolled into view; the code editor box only. */
  flash?: { readonly at: number; readonly length: number } | undefined
}) {
  const [large, setLarge] = useState(false)
  const match = useSearchMatch(path)
  const target = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!match) return
    for (let parent = target.current?.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true
    }
    const frame = requestAnimationFrame(() => {
      const input = target.current?.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null
      if (!input) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(match.at, match.at + match.length)
      scrollToSearchField(target.current!)
    })
    return () => cancelAnimationFrame(frame)
  }, [match])
  const value = useText(store, path)
  const kind = useEditorKind(store)
  // Card, preset and note text goes in the code editor box, with its macros marked.
  const card = kind === "card" || kind === "preset" || kind === "note"
  const field = textField(path)
  const props = {
    value,
    readOnly,
    spellCheck: !mono,
    className: mono ? "font-mono" : "",
    onBlur: () => void store.save(field)
  }
  // Its own controls, in the strip inside the box (ui/FieldFrame.tsx; owner, 2026-11-02).
  const status = <FieldStatus store={store} field={field} aside={aside} />
  const tools = (
    <>
      <FieldEditHistory store={store} field={field} label={label} reserve />
      {/* Open large (owner, 2026-11-02): every multi-line prose field. The code editor's box
          (card, preset and note text) has its own, in `ui/CodeEditorView`. */}
      {rows !== undefined && !card && !mono && !readOnly && (
        <IconButton
          data-layout-overlay="Expand action sits above the field in its label row"
          data-layout-audit-ignore="inset: Expand action belongs to the field label, outside the editable box"
          label={`Open ${label} large`}
          hint={`Opens ${label} large over the page, to write in a bigger box; it's the same text.`}
          icon="expand"
          className={chromeButton}
          onClick={() => setLarge(true)}
        />
      )}
    </>
  )
  return (
    <div ref={target} className="relative flex min-w-0 scroll-mt-[var(--preset-toolbar-height,1rem)] flex-col gap-1">
      {large && (
        <LargeField
          store={store}
          path={path}
          field={field}
          label={label}
          onClose={() => setLarge(false)}
          returnFocus={() => target.current?.querySelector<HTMLElement>("textarea")?.focus()}
        />
      )}
      <Field
        label={labelHidden ? label : <FieldLabel label={label} />}
        description={description}
        labelHidden={labelHidden}
        about={about ?? hint}
        aboutLabel={label}
      >
        {rows === undefined ? (
          <Input
            {...props}
            tools={tools}
            status={status}
            onChange={(event) => store.setText(path, event.currentTarget.value)}
          />
        ) : card ? (
          <CardTextEditor
            store={store}
            field={field}
            path={path}
            value={value}
            label={label}
            rows={rows}
            fullHeight={kind === "preset"}
            mono={mono}
            readOnly={readOnly}
            source={source}
            tools={tools}
            status={status}
            autoFocus={autoFocus}
            flash={flash}
            onChange={(value) => store.setText(path, value)}
            onBlur={props.onBlur}
          />
        ) : (
          <Textarea
            {...props}
            // Prose has them; a pattern (mono) doesn't.
            textActions={!mono}
            tools={tools}
            status={status}
            rows={rows}
            className={`resize-y ${fit ? "max-h-[min(60vh,32rem)] min-h-0! field-sizing-content" : ""} ${props.className}`}
            onChange={(event) => store.setText(path, event.currentTarget.value)}
          />
        )}
      </Field>
      <FieldTools store={store} field={field} label={label} history={false} />
    </div>
  )
}

/** One text field at the size of the screen, over the page; the same draft as the field in place. */
function LargeField({
  store,
  path,
  field,
  label,
  onClose,
  returnFocus
}: {
  store: EditorStore
  path: FieldPath
  field: string
  label: string
  onClose: () => void
  /** Back to the box in place, where the same text is. */
  returnFocus: () => void
}) {
  const value = useText(store, path)
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={label}
      wide
      finalFocus={() => {
        requestAnimationFrame(returnFocus)
        return false
      }}
    >
      <div>
        <CardTextEditor
          store={store}
          field={field}
          path={path}
          value={value}
          label={label}
          minHeight="min(65dvh, 48rem)"
          fullHeight
          expand={false}
          autoFocus
          tools={<FieldEditHistory store={store} field={field} label={label} reserve />}
          status={<FieldStatus store={store} field={field} />}
          onChange={(next) => store.setText(path, next)}
          onBlur={() => void store.save(field)}
        />
      </div>
      <FieldTools store={store} field={field} label={label} history={false} />
      <DialogActions>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** A number, kept as typed until it's a number, so "0." can become "0.5". */
export function NumberField({
  store,
  path,
  label,
  step = "any",
  min,
  max,
  integer = false,
  nullable = false,
  optional = false,
  about
}: {
  store: EditorStore
  path: FieldPath
  label: string
  about?: ReactNode
  step?: string
  min?: number
  max?: number
  integer?: boolean
  /** Empty means no value (null). */
  nullable?: boolean
  /** Empty omits an optional field. */
  optional?: boolean
}) {
  const value = useValue<number | null>(store, path)
  const [typed, setTyped] = useState<string | null>(null)
  const field = valueField(path)
  const accept = (text: string) => {
    setTyped(text)
    if ((nullable || optional) && text.trim() === "") {
      store.setValue(path, optional ? undefined : null)
      return
    }
    const number = Number(text)
    const valid =
      text.trim() !== "" &&
      Number.isFinite(number) &&
      (!integer || Number.isInteger(number)) &&
      (min === undefined || number >= min) &&
      (max === undefined || number <= max)
    if (valid && number !== value) store.setValue(path, number)
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={<FieldLabel store={store} field={field} label={label} />} about={about} aboutLabel={label}>
        <Input
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          value={typed ?? (typeof value === "number" ? String(value) : "")}
          onChange={(event) => accept(event.currentTarget.value)}
          onBlur={() => {
            setTyped(null)
            void store.save(field)
          }}
        />
      </Field>
      <FieldTools store={store} field={field} label={label} />
    </div>
  )
}

export function SwitchField({
  store,
  path,
  label,
  about,
  hint,
  checkbox = false
}: {
  store: EditorStore
  path: FieldPath
  label: string
  about?: ReactNode
  /** What switching it does, on hover and focus (explain): when the label doesn't say. */
  hint?: string
  checkbox?: boolean
}) {
  const value = useValue<boolean | undefined>(store, path) === true
  const Control = checkbox ? Checkbox : Switch
  return (
    <Control
      checked={value}
      onCheckedChange={(checked) => store.setValue(path, checked)}
      about={about}
      aboutLabel={label}
      hint={hint}
    >
      {label}
    </Control>
  )
}

/** A list of strings, one per line. Kept as typed, so a new empty line can be typed; empty lines aren't kept. */
export function LinesField({ store, path, label }: { store: EditorStore; path: FieldPath; label: string }) {
  const lines = useValue<ReadonlyArray<string>>(store, path) ?? []
  const [typed, setTyped] = useState<string | null>(null)
  const field = valueField(path)
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={<FieldLabel store={store} field={field} label={label} />}>
        <Textarea
          rows={2}
          spellCheck={false}
          className="resize-y font-mono"
          value={typed ?? lines.join("\n")}
          onChange={(event) => {
            const text = event.currentTarget.value
            setTyped(text)
            store.setValue(
              path,
              text.split("\n").filter((line) => line !== "")
            )
          }}
          onBlur={() => {
            setTyped(null)
            void store.save(field)
          }}
        />
      </Field>
      <FieldTools store={store} field={field} label={label} />
    </div>
  )
}

/** One of a few values. `text` when the field is a string the user could also type. */
export function SelectField<Value extends string>({
  store,
  path,
  label,
  about,
  items,
  fallback
}: {
  store: EditorStore
  path: FieldPath
  label: string
  about?: ReactNode
  items: ReadonlyArray<SelectItem<Value>>
  /** What an absent value means (a prompt's condition, from its ST triggers). */
  fallback?: Value
}) {
  const value = useValue<Value>(store, path)
  const field = valueField(path)
  return (
    <Field label={<FieldLabel store={store} field={field} label={label} />} about={about} aboutLabel={label}>
      <Select items={items} value={value ?? fallback ?? null} onValueChange={(next) => store.setValue(path, next)} />
    </Field>
  )
}

/**
 * ST's per-prompt Triggers: the generation types a prompt is sent for, written in the order
 * of `items`; none ticked is every type.
 */
export function TriggersField({
  store,
  path,
  label,
  items
}: {
  store: EditorStore
  path: FieldPath
  label: string
  items: ReadonlyArray<{ readonly value: string; readonly label: string }>
}) {
  const value = useValue<ReadonlyArray<string> | undefined>(store, path) ?? []
  const field = valueField(path)
  return (
    <Fieldset
      legend={<FieldLabel store={store} field={field} label={label} />}
      aboutLabel={label}
      about="Choose which kinds of reply include this text. None selected means all kinds. New version includes swipes and regenerations; Summary is a summary request."
      className="gap-1.5"
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {items.map((item) => (
          <Checkbox
            key={item.value}
            checked={value.includes(item.value)}
            onCheckedChange={(checked) => {
              const next = new Set(value.filter((t) => t !== item.value))
              if (checked) next.add(item.value)
              // Types this list doesn't name (an ST file's own) stay, after the known ones.
              const known = items.flatMap((i) => (next.has(i.value) ? [i.value] : []))
              store.setValue(path, [...known, ...[...next].filter((t) => !items.some((i) => i.value === t))])
            }}
          >
            {item.label}
          </Checkbox>
        ))}
      </div>
      <p className="text-xs text-muted">
        {value.length === 0 ? "Sent for every type." : "Sent only for the types ticked."}
      </p>
    </Fieldset>
  )
}

/** Names in a sentence: "A", "A and B", "A, B and C". */
const listed = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

/**
 * Text the user's own save sent to the bin's recovered texts (DESIGN §6.2): what a field had
 * before most of it was deleted or replaced, or another tab's text a save went over. It names
 * the fields when the store knows them, says where the text is, and goes when dismissed.
 */
export function RecoveredNotice({ store }: { store: EditorStore }) {
  const state = useEditorState(store)
  if (state.recovered === 0 || !state.snapshot) return null
  // The saved document names list elements well enough, without following every key typed.
  const { doc, ref } = state.snapshot
  const fields = state.recoveredFields.map((field) => draftLabel(ref.kind, doc, field))
  const one = state.recovered === 1
  return (
    <Alert tone="neutral" title={one ? "Your earlier text is in the bin" : "Your earlier texts are in the bin"}>
      <p>
        {fields.length > 0
          ? `What ${listed(fields)} had before you replaced most of it is kept in the bin, under Recovered text, in case you want it back.`
          : `What you replaced or deleted is kept in the bin, under Recovered text, in case you want it back.`}
      </p>
      {/* Under the text, so a narrow panel keeps the sentence readable. */}
      <div className="mt-1 flex flex-wrap gap-2">
        <Link to="/bin" search={{ section: "recovered" }} className={buttonClass("ghost")}>
          Open the bin
        </Link>
        <Button variant="ghost" onClick={() => store.dismissRecovered()}>
          Dismiss
        </Button>
      </div>
    </Alert>
  )
}

/** Says that changes kept in this browser when a page closed came back (backup.ts). */
export function RestoredNotice({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <Alert tone="warning" title="Brought back from this browser">
      <p>
        {count === 1 ? "A change" : `${count} changes`} typed before the page closed hadn't reached the server.{" "}
        {count === 1 ? "It's" : "They're"} back as unsaved changes: check them, then save.
      </p>
    </Alert>
  )
}
