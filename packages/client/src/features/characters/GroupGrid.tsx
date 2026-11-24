// Chats of several characters as tiles, read a page at a time: the characters filter's Groups,
// on the home grid and in the left panel.
import { useAtomRefresh } from "@effect/atom-react"
import { useLayoutEffect, useState } from "react"
import { FailureView } from "../../actions.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import type { CardBrowse } from "./cardBrowse.tsx"
import type { CardSort } from "./cardRecency.ts"
import { PAGE_ROWS, useShellForks } from "./shellData.tsx"
import { GroupTile, ShowMore } from "./ShellBrowser.tsx"

/**
 * A switch to Groups keeps the tab it came from on screen until the groups' first page is read,
 * then shows them in one frame: no loading line, no empty grid, nothing moving in between
 * (owner, 2026-11-23: "Transitions should not flash annoying intermediate states"). Draw the
 * characters' grid from `shown` (the browse before, while it holds) when `characters`; pass
 * `groups` to the GroupGrid when it's set. Opened on Groups with nothing before it, the grid's
 * own loading line shows.
 */
export function useGroupsSwitch<B extends CardBrowse>(browse: B) {
  const [ready, setReady] = useState(false)
  const holding = browse.filter === "groups" && !ready
  // React's "state from the previous render": the browse last drawn, kept while it holds.
  const [kept, setKept] = useState(browse)
  if (!holding && kept !== browse) setKept(browse)
  const shown = holding ? kept : browse
  return {
    shown,
    characters: shown.filter !== "groups",
    groups: browse.filter === "groups" ? { onReady: setReady, quiet: shown.filter !== "groups" } : null
  }
}

export function GroupGrid({
  needle,
  sort,
  reversed,
  className,
  onReady,
  quiet = false
}: {
  needle: string
  sort: CardSort
  reversed: boolean
  /** The grid's columns, for where it's shown. */
  className: string
  /** Told whether the first page is on screen, from a layout effect: before that frame paints. */
  onReady?: ((ready: boolean) => void) | undefined
  /** Draws nothing while the first page is read: what it replaces stays on screen (useGroupsSwitch). */
  quiet?: boolean | undefined
}) {
  const [limit, setLimit] = useState({ key: "", limit: PAGE_ROWS })
  const key = `${needle}/${sort}/${reversed}`
  const shown = limit.key === key ? limit.limit : PAGE_ROWS
  const forks = useShellForks({
    entity: null,
    chat: null,
    search: needle,
    sort,
    ...(reversed ? { reversed } : {}),
    sections: [{ id: "groups", limit: shown }]
  })
  const refresh = useAtomRefresh(forks.atom)
  const groups = forks.section("groups")
  const ready = !forks.loading || forks.failure !== null
  useLayoutEffect(() => onReady?.(ready), [onReady, ready])
  useLayoutEffect(() => () => onReady?.(false), [onReady])
  if (forks.loading)
    return forks.failure ? (
      <FailureView cause={forks.failure.cause} onRetry={refresh} />
    ) : quiet ? null : (
      <Loading label="Loading groups…" />
    )
  return (
    <div className="flex flex-col gap-3">
      <div aria-label="Groups" className={className}>
        {groups.rows.map((f) => (
          <GroupTile key={`${f.chat.id}/${f.forkId}`} fork={f} />
        ))}
      </div>
      {!groups.total && <p className="text-sm text-muted">No chats with several characters yet.</p>}
      <ShowMore
        shown={groups.rows.length}
        total={groups.total}
        onMore={() => setLimit({ key, limit: shown + PAGE_ROWS })}
      />
    </div>
  )
}
