// Chats of several characters as tiles, read a page at a time: the characters filter's Groups,
// on the home grid and in the left panel.
import { useAtomRefresh } from "@effect/atom-react"
import { useState } from "react"
import { FailureView } from "../../actions.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import type { CardSort } from "./cardRecency.ts"
import { PAGE_ROWS, useShellForks } from "./shellData.tsx"
import { GroupTile, ShowMore } from "./ShellBrowser.tsx"

/** A group has no Added of its own: it sorts by its chat's making, as Created does. */
const forkSort = (sort: CardSort) => (sort === "added" ? "created" : sort)

export function GroupGrid({
  needle,
  sort,
  reversed,
  className
}: {
  needle: string
  sort: CardSort
  reversed: boolean
  /** The grid's columns, for where it's shown. */
  className: string
}) {
  const [limit, setLimit] = useState({ key: "", limit: PAGE_ROWS })
  const key = `${needle}/${sort}/${reversed}`
  const shown = limit.key === key ? limit.limit : PAGE_ROWS
  const forks = useShellForks({
    entity: null,
    chat: null,
    search: needle,
    sort: forkSort(sort),
    ...(reversed ? { reversed } : {}),
    sections: [{ id: "groups", limit: shown }]
  })
  const refresh = useAtomRefresh(forks.atom)
  const groups = forks.section("groups")
  if (forks.loading)
    return forks.failure ? (
      <FailureView cause={forks.failure.cause} onRetry={refresh} />
    ) : (
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
