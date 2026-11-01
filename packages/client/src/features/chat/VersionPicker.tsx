// The version picker (DESIGN §3.1): a message's versions, built for dozens. Each one has a
// compact preview (its start, who wrote it or with which model, when), a star and a hide;
// hidden ones leave the arrows' cycle and are listed apart. A filter shows only the starred,
// and two can be compared side by side. The counter `k/n` opens it: a popover on a wide
// screen, a sheet on a phone.
import { positionOf } from "./position.ts"
import { useAtomValue } from "@effect/atom-react"
import type { PathEntry, Version } from "@rp/shared/chat.ts"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { ValueDiff } from "../editor/diff.tsx"
import { formatWhen } from "./chatTitle.ts"
import { liveText } from "./session.ts"

const NARROW = "(max-width: 639px)"
const subscribeNarrow = (listener: () => void) => {
  const query = matchMedia(NARROW)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
/** A phone-sized screen: lists open as sheets there. */
export const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => matchMedia(NARROW).matches)

const fullTime = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" })

/** A version's start as plain words: Markdown's marks would only take room in two lines. */
const preview = (text: string) => {
  const flat = text
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?(?=\s|$)/g, " ")
    .replace(/[*_`~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return flat === "" ? "(empty)" : flat.length > 240 ? `${flat.slice(0, 240)}…` : flat
}

/** Who wrote a version, or with which model: what tells versions apart besides their text. */
const writerOf = (version: Version, numberOf: (id: Version["id"]) => number | undefined) => {
  if (version.origin === "edited") {
    const source = version.sourceVersionId === null ? undefined : numberOf(version.sourceVersionId)
    return source === undefined ? "Edited by you" : `Edited from #${source}`
  }
  if (version.origin === "greeting") return "Greeting"
  if (version.writer === "human") return version.origin === "imported" ? "Imported, written by you" : "Written by you"
  return version.model ?? (version.origin === "imported" ? "Imported, by a model" : "Model not recorded")
}

function StatusBadges({ version }: { version: Version }) {
  return (
    <>
      {version.status === "generating" && <Badge tone="accent">generating</Badge>}
      {(version.status === "stopped" || version.status === "interrupted") && (
        <Badge tone="warning">{version.status}</Badge>
      )}
      {version.status === "failed" && <Badge tone="danger">failed</Badge>}
      {version.mark === "refused" && <Badge tone="warning">refused</Badge>}
    </>
  )
}

type Flags = { readonly starred?: boolean; readonly hidden?: boolean }

interface PickerProps {
  readonly entry: PathEntry
  readonly versions: ReadonlyArray<Version> | null
  readonly onPick: (version: Version) => void
  readonly onFlag: (version: Version, flags: Flags) => void
}

/** One version in the list: pick it, star it, hide it (or show it again); or tick it to compare. */
function Row({
  version,
  number,
  current,
  writer,
  comparing,
  ticked,
  onPick,
  onTick,
  onFlag
}: {
  version: Version
  number: number
  current: boolean
  writer: string
  comparing: boolean
  ticked: boolean
  onPick: () => void
  onTick: () => void
  onFlag: (flags: Flags) => void
}) {
  const text = useAtomValue(liveText(version.id)) ?? version.content
  const body = (
    <>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
        <span className="font-semibold text-text tabular-nums">#{number}</span>
        <span className="min-w-0 truncate" title={writer}>
          {writer}
        </span>
        <span aria-hidden="true">·</span>
        <time dateTime={new Date(version.createdAt).toISOString()} title={fullTime.format(version.createdAt)}>
          {formatWhen(version.createdAt)}
        </time>
        {current && <span className="font-medium text-accent">shown</span>}
        {comparing && version.starred && (
          <span className="text-warning" role="img" aria-label="Starred">
            <Icon name="star" size={12} filled />
          </span>
        )}
        <StatusBadges version={version} />
      </span>
      <span className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{preview(text)}</span>
    </>
  )
  return (
    <li
      data-version={version.id}
      className={`flex items-start gap-1 rounded-md border ${
        current ? "border-accent bg-accent/5" : ticked ? "border-focus" : "border-transparent hover:bg-surface-raised"
      }`}
    >
      {comparing ? (
        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 px-2 py-1.5">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-accent"
            checked={ticked}
            onChange={onTick}
            aria-label={`Compare version ${number}`}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">{body}</span>
        </label>
      ) : (
        <button
          type="button"
          aria-current={current || undefined}
          aria-label={`Version ${number}, ${writer}${current ? ", shown" : ""}: ${preview(text).slice(0, 80)}`}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={onPick}
        >
          {body}
        </button>
      )}
      {!comparing && (
        <div className="flex shrink-0 items-center py-0.5 pr-0.5">
          <IconButton
            label={version.starred ? `Unstar version ${number}` : `Star version ${number}`}
            icon="star"
            filled={version.starred}
            aria-pressed={version.starred}
            className={version.starred ? "text-warning! hover:text-warning!" : ""}
            onClick={() => onFlag({ starred: !version.starred })}
          />
          <IconButton
            label={
              version.hidden ? `Show version ${number} in the arrows again` : `Hide version ${number} from the arrows`
            }
            icon={version.hidden ? "eye" : "ghost"}
            onClick={() => onFlag({ hidden: !version.hidden })}
          />
        </div>
      )}
    </li>
  )
}

/** The picker's content: the filter, the list with its hidden part, and picking two to compare. */
function PickerBody({
  entry,
  versions,
  onPick,
  onFlag,
  onCompare,
  open
}: PickerProps & { onCompare: (pair: readonly [Version["id"], Version["id"]]) => void; open: boolean }) {
  const [filter, setFilter] = useState<"all" | "starred">("all")
  const [ticked, setTicked] = useState<ReadonlyArray<Version["id"]> | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // Opened, it scrolls to the version that's shown, in the middle of the list.
  useEffect(() => {
    if (!open || versions === null) return
    const frame = requestAnimationFrame(() => {
      const box = list.current
      const row = box?.querySelector<HTMLElement>(`[data-version="${entry.version.id}"]`)
      if (box && row) box.scrollTop = row.offsetTop - (box.clientHeight - row.offsetHeight) / 2
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the list is there
  }, [open, versions === null])
  if (versions === null) return <p className="px-1 py-2 text-sm text-muted">Loading the versions…</p>
  const numbers = new Map(versions.map((v, i) => [v.id, i + 1]))
  const numberOf = (id: Version["id"]) => numbers.get(id)
  const starred = versions.filter((v) => v.starred).length
  const wanted = versions.filter((v) => filter === "all" || v.starred)
  const shown = wanted.filter((v) => !v.hidden)
  const hidden = wanted.filter((v) => v.hidden)
  const comparing = ticked !== null
  const tick = (id: Version["id"]) => {
    if (ticked === null) return
    const next = ticked.includes(id) ? ticked.filter((t) => t !== id) : [...ticked, id]
    if (next.length < 2) return setTicked(next)
    const pair = next.map((t) => versions.find((v) => v.id === t)!).sort((a, b) => a.ordinal - b.ordinal)
    setTicked(null)
    onCompare([pair[0]!.id, pair[1]!.id])
  }
  const row = (version: Version) => (
    <Row
      key={version.id}
      version={version}
      number={numbers.get(version.id)!}
      current={version.id === entry.version.id}
      writer={writerOf(version, numberOf)}
      comparing={comparing}
      ticked={ticked?.includes(version.id) ?? false}
      onPick={() => onPick(version)}
      onTick={() => tick(version.id)}
      onFlag={(flags) => onFlag(version, flags)}
    />
  )
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Show"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: `All ${versions.length}` },
            {
              value: "starred",
              label: (
                <>
                  <Icon name="star" size={14} filled={starred > 0} />
                  Starred {starred}
                </>
              )
            }
          ]}
        />
        <span className="flex-1" />
        {comparing ? (
          <Button variant="ghost" className="h-8" onClick={() => setTicked(null)}>
            Cancel
          </Button>
        ) : (
          <Button className="h-8" disabled={versions.length < 2} onClick={() => setTicked([])}>
            <Icon name="compare" />
            Compare
          </Button>
        )}
      </div>
      {comparing && (
        <p className="text-sm text-muted" role="status">
          Tick two versions to compare them side by side{ticked.length === 1 ? ": one more" : "."}
        </p>
      )}
      <div ref={list} className="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {shown.length === 0 && filter === "starred" && hidden.length === 0 ? (
          <p className="py-2 text-sm text-muted">No starred versions yet. Star one with its ☆ button.</p>
        ) : (
          <ol className="flex flex-col gap-0.5" aria-label="Versions">
            {shown.map(row)}
          </ol>
        )}
        {hidden.length > 0 && (
          <details className="mt-2" open={comparing || undefined}>
            <summary className="cursor-pointer rounded-md px-2 py-1 text-sm text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus">
              Hidden {hidden.length}: left out of the arrows
            </summary>
            <ol className="mt-1 flex flex-col gap-0.5" aria-label="Hidden versions">
              {hidden.map(row)}
            </ol>
          </details>
        )}
      </div>
    </>
  )
}

/** Two versions side by side, or what changed between them, with a way to show either. */
function Compare({
  pair,
  numberOf,
  onClose,
  onPick
}: {
  pair: readonly [Version, Version]
  numberOf: (id: Version["id"]) => number | undefined
  onClose: () => void
  onPick: (version: Version) => void
}) {
  const [view, setView] = useState<"side" | "changes">("side")
  const firstText = useAtomValue(liveText(pair[0].id)) ?? pair[0].content
  const secondText = useAtomValue(liveText(pair[1].id)) ?? pair[1].content
  const column = (version: Version, index: number) => {
    const number = numberOf(version.id) ?? 0
    return (
      <section key={version.id} aria-label={`Version ${number}`} className="flex min-w-0 flex-col gap-2">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold tabular-nums">#{number}</span>
          <span className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">{writerOf(version, numberOf)}</span>
          <span className="text-xs text-muted">{formatWhen(version.createdAt)}</span>
          {version.starred && (
            <span className="text-warning" role="img" aria-label="Starred">
              <Icon name="star" size={14} filled />
            </span>
          )}
          <StatusBadges version={version} />
          <span className="flex-1" />
          <Button className="h-8" onClick={() => onPick(version)}>
            Show #{number}
          </Button>
        </header>
        <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border p-3 max-sm:max-h-none">
          <Markdown text={index === 0 ? firstText : secondText} streaming={version.status === "generating"} />
        </div>
      </section>
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      wide
      title={`Version ${numberOf(pair[0].id)} and version ${numberOf(pair[1].id)}`}
    >
      <>
        <div>
          <Segmented
            label="Compare as"
            value={view}
            onValueChange={setView}
            options={[
              { value: "side", label: "Both texts" },
              { value: "changes", label: "What changed" }
            ]}
          />
        </div>
        {view === "side" ? (
          <div className="grid gap-4 sm:grid-cols-2">{pair.map(column)}</div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted">
              From #{numberOf(pair[0].id)} to #{numberOf(pair[1].id)}: complete texts with changes marked.
            </p>
            <ValueDiff before={firstText} after={secondText} rich />
          </div>
        )}
      </>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * `‹ 3/7 ›`'s counter: it opens the picker. `hiddenCount` versions are out of the arrows'
 * cycle; the counter numbers every version, so #4 is #4 wherever it's seen.
 */
export function VersionPicker({
  entry,
  versions,
  position,
  onOpen,
  onPick,
  onFlag
}: PickerProps & { position: number; onOpen: () => void }) {
  const narrow = useNarrow()
  const [open, setOpen] = useState(false)
  const [pairIds, setPairIds] = useState<readonly [Version["id"], Version["id"]] | null>(null)
  // Keep identities, not snapshots: completion replaces content and metadata in the list.
  const first = versions?.find((version) => version.id === pairIds?.[0])
  const second = versions?.find((version) => version.id === pairIds?.[1])
  const pair = first && second ? ([first, second] as const) : null
  const count = entry.versionCount
  const hiddenCount = versions?.filter((v) => v.hidden).length ?? 0
  const counter = position >= 0 ? `${position + 1}/${count}` : `${count}`
  const label =
    (position >= 0 ? `Version ${position + 1} of ${count}` : `${count} versions`) +
    (hiddenCount > 0 ? `, ${hiddenCount} hidden` : "") +
    ": choose a version"
  const title = `Versions of message #${positionOf(entry) + 1}`
  const openChange = (next: boolean) => {
    setOpen(next)
    if (next) onOpen()
  }
  const numbers = new Map(versions?.map((v, i) => [v.id, i + 1]) ?? [])
  const body = (
    <PickerBody
      entry={entry}
      versions={versions}
      open={open}
      onPick={(version) => {
        setOpen(false)
        onPick(version)
      }}
      onFlag={onFlag}
      onCompare={(next) => {
        setOpen(false)
        setPairIds(next)
      }}
    />
  )
  const counterClass =
    "h-8 min-w-9 rounded-md px-1 text-xs text-muted tabular-nums outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-hover"
  let picker: ReactNode
  if (narrow)
    picker = (
      <>
        <button type="button" aria-label={label} className={counterClass} onClick={() => openChange(true)}>
          {counter}
        </button>
        <Sheet open={open} onOpenChange={openChange} title={title}>
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">{body}</div>
        </Sheet>
      </>
    )
  else
    picker = (
      <Popover
        open={open}
        onOpenChange={openChange}
        trigger={counter}
        triggerLabel={label}
        triggerClassName={counterClass}
        hint="Choose a version"
        title={title}
        side="top"
        align="end"
        wide
      >
        {body}
      </Popover>
    )
  return (
    <>
      {picker}
      {pair && (
        <Compare
          pair={pair}
          numberOf={(id) => numbers.get(id)}
          onClose={() => setPairIds(null)}
          onPick={(version) => {
            setPairIds(null)
            onPick(version)
          }}
        />
      )}
    </>
  )
}
