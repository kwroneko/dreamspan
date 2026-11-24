// The change rows between a workshop's turns (spec/WORKSHOP-CARDS.md §7): under the last message
// of a turn, one row per library item the turn made or edited. The name opens the item as it is
// now; the count opens what changed (the change view). Both open where a card editor is shown
// beside the chat, as the request inspector does. A `messageStream` entry, so a plugin can
// replace or remove it.
import type { PathEntry } from "@dreamspan/shared/chat.ts"
import type { EntityKind } from "@dreamspan/shared/library.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { linkMenuProps } from "../../ui/linkMenuState.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { browsable, shellAtom } from "../characters/shellData.tsx"
import { kindShows } from "../chat/kindLooks.ts"
import type { ChatSession } from "../chat/session.ts"
import { fieldLabel } from "../editor/fields.ts"
import { openNearProps } from "../workbench/kinds.ts"
import {
  type ChangeReply,
  changeCount,
  changedNames,
  changedSince,
  changeViewHref,
  FOLD_ABOVE,
  FOLD_NAMED,
  type ItemChange,
  itemChanges,
  itemUndone,
  turnEndingAt
} from "./changeRows.ts"
import { CHANGES, versionEffectsAtom } from "./effects.ts"
import { ItemChangeAction } from "./ItemChangeAction.tsx"
import { itemChangeAtom, itemChangeKey } from "./itemChange.ts"

/** The change view's tab kind (index.tsx). */
export const CHANGE_KIND = "library.change"
const EDITOR_KIND = "library.editor"

const link =
  "rounded-sm outline-none [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-focus"

/** The item's face: a card's portrait, a lorebook's or preset's icon in a box the same size. */
export function ItemPicture({ item }: { item: Pick<ItemChange, "entityId" | "kind" | "label"> }) {
  const card = useShellCard(item)
  if (item.kind === "card")
    return (
      <Avatar
        id={item.entityId}
        name={card?.name ?? item.label}
        mediaId={card?.avatarMediaId ?? null}
        crop={card?.avatarCrop}
        size="sm"
      />
    )
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-9 w-6 shrink-0 items-center justify-center rounded-sm bg-surface-raised text-muted"
    >
      <Icon name={item.kind === "lorebook" ? "book" : "sliders"} size={16} />
    </span>
  )
}

/** A card as the shell lists it now (its name and portrait); undefined for other kinds. */
const useShellCard = (item: Pick<ItemChange, "entityId" | "kind">) => {
  const shell = useAtomValue(shellAtom)
  if (item.kind !== "card" || !AsyncResult.isSuccess(shell)) return undefined
  return browsable(shell.value).find((c) => c.card.entityId === item.entityId)?.card
}

/** The item's name now: a card's from the shell, else as the change named it. */
const useItemName = (item: Pick<ItemChange, "entityId" | "kind" | "label">) => useShellCard(item)?.name ?? item.label

function Row({ item, reply }: { item: ItemChange; reply: ChangeReply }) {
  const name = useItemName(item)
  const detail = useAtomValue(itemChangeAtom(itemChangeKey(item.refId, item.from, item.to)))
  const loaded = AsyncResult.isSuccess(detail) ? detail.value : null
  const what = item.created ? `New ${item.kind}` : "Edited"
  const count = loaded ? `${what} · ${changeCount(item.kind, loaded.changes)}` : what
  const names = loaded
    ? changedNames(
        loaded.changes.map((c) => fieldLabel(item.kind as EntityKind, loaded.after, [c.path[0]!], loaded.before))
      )
    : ""
  const since = loaded ? changedSince(loaded.revisions, item.to) : null
  const undone = itemUndone(item)
  return (
    <div data-change-row={item.refId} className="flex items-center gap-2 text-xs">
      <ItemPicture item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <Tooltip label={`Opens ${name} as it is now.`}>
            <a
              href={`/library/${encodeURIComponent(item.refId)}`}
              data-change-name
              className={`${link} min-w-0 text-sm font-medium ${undone ? "text-muted" : "text-text"}`}
              {...openNearProps(EDITOR_KIND)}
              {...linkMenuProps}
            >
              {name}
            </a>
          </Tooltip>
          <Tooltip label={names ? `Shows what the assistant changed: ${names}.` : "Shows what the assistant changed."}>
            <a
              href={changeViewHref(item, reply)}
              data-change-count
              className={`${link} text-muted hover:text-text`}
              {...openNearProps(CHANGE_KIND, `/library/${encodeURIComponent(item.refId)}`)}
              {...linkMenuProps}
            >
              {count}
            </a>
          </Tooltip>
        </div>
        {since && !undone && (
          <span data-changed-since className="text-muted">
            {since === "you" ? "Changed since by you" : "Changed since by a later reply"}
          </span>
        )}
      </div>
      <ItemChangeAction item={item} />
    </div>
  )
}

function Rows({ reply }: { reply: ChangeReply }) {
  const result = useAtomValue(versionEffectsAtom(reply.versionId))
  const [all, setAll] = useState(false)
  if (!AsyncResult.isSuccess(result)) return null
  const items = itemChanges(result.value)
  if (items.length === 0) return null
  const folded = items.length > FOLD_ABOVE && !all
  return (
    <div
      role="group"
      aria-label="What this reply changed in the library"
      data-change-rows
      className="my-1 flex w-full max-w-controls flex-col gap-1 rounded-md border border-border p-2"
    >
      {folded ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 text-muted [overflow-wrap:anywhere]">
            Changed {items.length} items:{" "}
            {items
              .slice(0, FOLD_NAMED)
              .map((i) => i.label)
              .join(", ")}{" "}
            and {items.length - FOLD_NAMED} more
          </span>
          <Button
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            hint="Shows a row for each item this reply changed."
            onClick={() => setAll(true)}
          >
            Show all
          </Button>
        </div>
      ) : (
        items.map((item) => <Row key={item.entityId} item={item} reply={reply} />)
      )}
    </div>
  )
}

/**
 * The turn's key when `entry` ends one in a workshop: its first version, its last slot, and
 * whether it's the path's latest turn.
 */
const turnKey = (session: ChatSession, entry: PathEntry) => {
  const snapshot = session.snapshot()
  if (!kindShows(snapshot.chat?.kind, CHANGES)) return null
  const turn = turnEndingAt(snapshot.entries, entry.slotId)
  if (!turn) return null
  const latest = snapshot.newer === null && snapshot.entries.at(-1)?.slotId === entry.slotId
  return `${turn.first.version.id}\n${turn.last.slotId}\n${latest ? "latest" : ""}`
}

export function ChangeRows({
  entry,
  session,
  place
}: {
  entry: PathEntry
  session: ChatSession
  place: "above" | "below"
}) {
  const key = useSyncExternalStore(session.subscribe, () => turnKey(session, entry))
  const generating = entry.version.status === "generating"
  if (place !== "below" || key === null || generating) return null
  const [versionId, slotId, latest] = key.split("\n") as [string, string, string]
  const reply = { chatId: session.id, slotId, versionId }
  return latest ? <Fresh key={key} reply={reply} /> : <Rows key={key} reply={reply} />
}

/**
 * The latest turn's changes, read again once when it's done: the list may have been read while
 * the turn was still running (a step's own rows read it). An earlier turn's list stands until an
 * undo or a change reads every list again.
 */
function Fresh({ reply }: { reply: ChangeReply }) {
  const refresh = useAtomRefresh(versionEffectsAtom(reply.versionId))
  const read = useRef(false)
  useEffect(() => {
    if (read.current) return
    read.current = true
    refresh()
  }, [refresh])
  return <Rows reply={reply} />
}
