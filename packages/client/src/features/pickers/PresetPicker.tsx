import { ChatLock } from "./PickerParts.tsx"
// The prompt preset picker (the owner, 2026-11-01): the composer's preset chip and the Prompt
// preset tab open this same list. A filter; Name, Modified, Used or Archived; each preset with
// when it was edited under its name; an archive button on each row (un-archive in Archived)
// that neither chooses it nor closes the list; and New preset at the end. The body is the
// registered `preset.picker` entry, so a plugin can replace it.
import { BUILTIN_PRESET_LABEL } from "@rp/shared/generation.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useId, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { SlotOutlet, defineSlot } from "../../slots.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { NEW_PRESET_HINT, NewPresetDialog, newPresetName } from "../editor/NewPreset.tsx"
import {
  type PickerBodyProps,
  type PickerItem,
  PickerFooterButton,
  PickerList,
  PickerPopover,
  PickerSearch
} from "./PickerParts.tsx"
import { PRESET_VIEWS, type PresetView, isArchived, presetDetail, presetTimes, presetsInView } from "./presetList.ts"
import { BUILTIN, type PresetSelection } from "./presetSelection.ts"

export interface PresetPickerProps extends PickerBodyProps {
  readonly selection: PresetSelection
  /** "New preset…": the host closes the list and opens the dialog, which outlives it. */
  readonly onNew: () => void
}

/** The registered preset picker body (`preset.picker`); a plugin may replace or add to it. */
export const presetPickers = defineSlot<PresetPickerProps>("preset.picker")

const lines = (items: ReadonlyArray<string>): ReactNode => (
  <span className="flex flex-col">
    {items.map((line) => (
      <span key={line}>{line}</span>
    ))}
  </span>
)

export function PresetPicker({ selection, focusRef, focus, onChosen, onNew }: PresetPickerProps) {
  const { prefs, change } = useViewPrefs()
  const [archivedView, setArchivedView] = useState(false)
  const view: PresetView = archivedView ? "archived" : prefs.presetSort
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [last, setLast] = useState<{ ref: LibraryRef; archived: boolean } | null>(null)
  const listId = useId()
  const { live, archived, value, current } = selection
  const shown = presetsInView(view, query, live, archived)
  const q = query.trim()
  const matchesBuiltin = q === "" || BUILTIN_PRESET_LABEL.toLowerCase().includes(q.toLowerCase())
  // The preset in use stays shown though archived: marked so, at the top of the other views.
  const pinned = view !== "archived" && current !== null && isArchived(current) ? current : null

  const archive = async (ref: LibraryRef, next: boolean) => {
    setPending(ref.id)
    const saved = await selection.setArchived(ref, next)
    setPending(null)
    if (saved) setLast({ ref: saved, archived: next })
  }
  const row = (ref: LibraryRef): PickerItem => {
    const inUse = ref.id === value
    const archivedRow = isArchived(ref)
    return {
      value: ref.id,
      label: ref.label,
      detail: presetDetail(ref, view),
      ...(archivedRow && view !== "archived" ? { badge: <Badge tone="warning">Archived</Badge> } : {}),
      tooltip: lines([
        selection.usage === "edit"
          ? inUse
            ? "Shown in this editor"
            : "Opens this preset in this editor"
          : selection.usage === "summary"
            ? inUse
              ? "In use for summaries"
              : "Use this preset for summaries"
            : inUse
              ? `In use for the next reply in ${selection.lock?.locked ? "this chat only" : "every chat"}`
              : `Use this preset for the next reply in ${selection.lock?.locked ? "this chat only" : "every chat"}`,
        ...presetTimes(ref)
      ]),
      action: archivedRow
        ? {
            label: `Unarchive ${ref.label}`,
            hint: "Unarchive: show it in these lists again",
            icon: "unarchive",
            pending: pending === ref.id,
            onClick: () => void archive(ref, false)
          }
        : {
            label: `Archive ${ref.label}`,
            hint: "Archive: hide it from these lists; nothing is deleted",
            icon: "archive",
            pending: pending === ref.id,
            onClick: () => void archive(ref, true)
          }
    }
  }
  const items: Array<PickerItem> = [
    ...(pinned ? [row(pinned)] : []),
    ...(selection.usage === undefined && view !== "archived" && matchesBuiltin
      ? [
          {
            value: BUILTIN,
            label: BUILTIN_PRESET_LABEL,
            detail: "built in",
            tooltip: lines([
              value === BUILTIN
                ? `In use for the next reply in ${selection.lock?.locked ? "this chat only" : "every chat"}`
                : `Use the built-in default preset for the next reply in ${selection.lock?.locked ? "this chat only" : "every chat"}`,
              "Built in: it can't be edited or archived"
            ])
          }
        ]
      : []),
    ...shown.filter((ref) => ref.id !== pinned?.id).map(row)
  ]
  const archivedCount = new Set([...archived, ...live].filter(isArchived).map((ref) => ref.id)).size
  return (
    <>
      <ChatLock lock={selection.lock} kind="preset" />
      <PickerSearch
        label="Find a prompt preset"
        placeholder="Find by name"
        value={query}
        onChange={setQuery}
        inputRef={focus === "search" ? focusRef : search}
        controls={listId}
      />
      <Segmented<PresetView>
        label="Show presets"
        value={view}
        onValueChange={(next) => {
          setArchivedView(next === "archived")
          if (next !== "archived" && next !== prefs.presetSort) void change({ presetSort: next })
        }}
        options={PRESET_VIEWS.map((option) => ({
          value: option.value,
          description: option.description,
          label: option.value === "archived" && archivedCount > 0 ? `${option.label} · ${archivedCount}` : option.label
        }))}
      />
      <PickerList
        id={listId}
        title="Prompt preset"
        items={items}
        value={value}
        onChoose={(next) => {
          onChosen()
          if (next !== value) void selection.choose(next)
        }}
        focusRef={focus === "current" ? focusRef : undefined}
        fallbackFocus={focus === "search" ? focusRef : search}
        empty={
          view === "archived"
            ? q
              ? `No archived preset is called “${q}”.`
              : "No archived presets. Archive one with the box beside it to hide it from these lists; nothing is deleted."
            : `Nothing is called “${q}”.`
        }
      />
      {last && (
        <p role="status" className="flex shrink-0 flex-wrap items-center gap-x-2 px-2 text-xs text-muted">
          <span className="[overflow-wrap:anywhere]">
            {last.archived
              ? `Archived “${last.ref.label}”: it's under Archived.`
              : `“${last.ref.label}” is back in the lists.`}
          </span>
          <Tooltip label={last.archived ? "Take it out of the archive again" : "Archive it again"}>
            <button
              type="button"
              className="rounded-sm text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              onClick={() => {
                const { ref, archived: was } = last
                setLast(null)
                void archive(ref, !was)
              }}
            >
              Undo
            </button>
          </Tooltip>
        </p>
      )}
      <ErrorAlert error={selection.error} />
      <PickerFooterButton
        hint={
          selection.usage === "edit"
            ? `${NEW_PRESET_HINT}, opened in this editor`
            : `${NEW_PRESET_HINT}, ${selection.usage === "summary" ? "chosen for summaries" : "chosen for the next reply"} and opened for editing`
        }
        icon="plus"
        onClick={onNew}
      >
        New preset…
      </PickerFooterButton>
    </>
  )
}

/** After "New preset": it's chosen, as a choice in the list would be, and opened for editing. */
export function useNewPreset(selection: PresetSelection) {
  const workspace = usePresetWorkspace()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const dialog = (
    <NewPresetDialog
      open={open}
      onOpenChange={setOpen}
      name={newPresetName([...selection.live, ...selection.archived].map((ref) => ref.label))}
      onCreated={async (ref) => {
        await selection.choose(ref.id)
        // An editor's header picker opens it in that editor as it's chosen.
        if (selection.usage === "edit") return
        if (workspace) workspace.open(ref.id)
        else void navigate({ to: "/library/$refId", params: { refId: ref.id } })
      }}
    />
  )
  return { start: () => setOpen(true), dialog }
}

/**
 * The picker in its popover, opened by `trigger` (the composer's chip, the tab's dropdown):
 * the registered body, then the host's `footer` rows; the New preset dialog outlives it.
 */
export function PresetPickerPopover({
  selection,
  trigger,
  triggerLabel,
  triggerClassName,
  hint,
  side,
  footer
}: {
  selection: PresetSelection
  trigger: ReactNode
  triggerLabel: string
  triggerClassName?: string
  hint?: ReactNode
  side?: "top" | "bottom"
  footer?: (close: () => void) => ReactNode
}) {
  const created = useNewPreset(selection)
  return (
    <>
      <PickerPopover
        title="Prompt preset"
        trigger={trigger}
        triggerLabel={triggerLabel}
        {...(triggerClassName === undefined ? {} : { triggerClassName })}
        hint={hint}
        {...(side === undefined ? {} : { side })}
        onOpen={selection.refresh}
        {...(footer === undefined ? {} : { footer })}
      >
        {(body) => (
          <SlotOutlet
            slot={presetPickers}
            props={{
              ...body,
              selection,
              onNew: () => {
                body.onChosen()
                created.start()
              }
            }}
          />
        )}
      </PickerPopover>
      {created.dialog}
    </>
  )
}
