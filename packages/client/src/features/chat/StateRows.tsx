// The quiet lines in the message list where something the next replies are written from
// changed (stateMarkers.ts): under the message after which it changed, one line a message
// however many changes it holds ("3 changes: …", opened to list them), each change with what it
// means on hover and a link to where it's set. Lighter than the away rows and the merged chat's
// row: no rule, no face, small muted type. A `messageStream` entry, so a plugin can replace or
// remove it; the kinds are `stateMarkerKinds`, each with a switch in the Interface settings.
import type { PathEntry } from "@rp/shared/chat.ts"
import { useParams } from "@tanstack/react-router"
import { useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useShowPanel } from "./panels.tsx"
import type { ChatSession } from "./session.ts"
import { type StateChange, type StateMark, stateMarkerKinds, stateMarksOf } from "./stateMarkers.ts"

const useKinds = () =>
  useSyncExternalStore(stateMarkerKinds.subscribe, stateMarkerKinds.snapshot, stateMarkerKinds.snapshot).entries

function Change({ change, open }: { change: StateChange; open: StateMark["open"] | null }) {
  const show = useShowPanel()
  return (
    <span className="inline-flex max-w-full min-w-0 flex-wrap items-center justify-center gap-x-1">
      <Tooltip label={change.explanation}>
        <span
          tabIndex={0}
          data-state-change={change.id}
          className="min-w-0 rounded-md px-1 py-0.5 [overflow-wrap:anywhere] outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {change.text}
        </span>
      </Tooltip>
      {open && (
        <Button
          variant="ghost"
          className="h-6! px-1.5! text-xs!"
          hint={`Opens ${open.label}, where this is set.`}
          aria-label={`Open ${open.label}: ${change.text}`}
          onClick={() => show(open.panel)}
        >
          {open.label}
        </Button>
      )}
    </span>
  )
}

export function StateRows({
  entry,
  session,
  place
}: {
  entry: PathEntry
  session: ChatSession
  place: "above" | "below"
}) {
  const store = stateMarksOf(session)
  const marks = useSyncExternalStore(store.subscribe, () => store.at(entry.slotId))
  // Most messages have none: nothing more is read for them.
  if (place !== "below" || marks.length === 0) return null
  return <Marked entry={entry} session={session} marks={marks} />
}

function Marked({
  entry,
  session,
  marks
}: {
  entry: PathEntry
  session: ChatSession
  marks: ReadonlyArray<StateMark>
}) {
  const store = stateMarksOf(session)
  const kinds = useKinds()
  const hidden = useViewPrefs().prefs.stateMarkers
  const chat = useSyncExternalStore(session.subscribe, () => session.snapshot().chat)
  // A chat shown inside another's panel has no panel of its own to open.
  const own = (useParams({ strict: false }) as { chatId?: string }).chatId === session.id
  const [opened, setOpened] = useState(() => store.open.has(entry.slotId))
  const workshop = chat !== null && chat.kind !== "rp"
  const shown = marks.filter((mark) => {
    const kind = kinds.find((one) => one.id === mark.kind)
    return kind !== undefined && hidden[mark.kind] !== false && (!workshop || kind.workshop === true)
  })
  const changes = shown.flatMap((mark) =>
    mark.changes.map((change) => ({ key: `${mark.kind}:${change.id}`, change, open: own ? (mark.open ?? null) : null }))
  )
  if (changes.length === 0) return null
  const toggle = () => {
    if (opened) store.open.delete(entry.slotId)
    else store.open.add(entry.slotId)
    setOpened(!opened)
  }
  return (
    <div
      role="group"
      aria-label="What changed here"
      data-state-markers={entry.slotId}
      className="flex w-full flex-col items-center gap-0.5 px-2 py-2 text-xs text-muted compact:py-1"
    >
      {changes.length === 1 ? (
        <span className="flex max-w-full min-w-0 items-center justify-center gap-1">
          <Icon name="sliders" size={12} className="shrink-0" />
          <Change change={changes[0]!.change} open={changes[0]!.open} />
        </span>
      ) : (
        <>
          <Button
            variant="ghost"
            className="h-6! max-w-full min-w-0 gap-1! px-1.5! text-xs! font-normal!"
            aria-expanded={opened}
            hint={opened ? "Hides the list of what changed here." : "Lists what changed here, each with what it means."}
            onClick={toggle}
          >
            <Icon name="sliders" size={12} className="shrink-0" />
            <span className="min-w-0 truncate">
              {changes.length} changes{opened ? "" : `: ${changes.map(({ change }) => change.text).join(" · ")}`}
            </span>
            <Icon name="down" size={12} className={`shrink-0 ${opened ? "rotate-180" : ""}`} />
          </Button>
          {opened && (
            <ul className="flex max-w-full min-w-0 flex-col items-center gap-0.5">
              {changes.map(({ key, change, open }) => (
                <li key={key} className="flex max-w-full min-w-0 justify-center">
                  <Change change={change} open={open} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** A switch per registered kind of change, on unless the user turned it off. */
export function StateMarkerSettings() {
  const viewer = useViewPrefs()
  const kinds = useKinds()
  const choices = viewer.prefs.stateMarkers
  const sorted = [...kinds].sort((a, b) => a.order - b.order)
  if (sorted.length === 0) return null
  return (
    <Fieldset
      legend="Changes shown in the chat"
      about="A small line under the message after which something changed for the replies that follow. Only you see these lines: they're never sent to the model, exported or numbered."
    >
      {sorted.map((kind) => (
        <Switch
          key={kind.id}
          checked={choices[kind.id] !== false}
          disabled={!viewer.ready}
          onCheckedChange={(next) =>
            void viewer.change({ stateMarkers: { ...choices, [kind.id]: next } }, { stateMarkers: { [kind.id]: next } })
          }
          about={kind.description}
        >
          {kind.label}
        </Switch>
      ))}
    </Fieldset>
  )
}
