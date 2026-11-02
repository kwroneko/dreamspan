// The characters' filter and sort in one compact row, for a narrow place: the left panel's
// grid (with Groups) and Start a chat (without). The home page lays the same parts out wide.
import { type CardBrowse, CardFilterControl, CardSortControl } from "./cardBrowse.tsx"
import { type ShellLibrary, useGroupCount } from "./shellData.tsx"

function GroupsFilter({
  data,
  browse,
  onChange
}: {
  data: ShellLibrary
  browse: CardBrowse
  onChange: (change: Partial<CardBrowse>) => void
}) {
  const groups = useGroupCount()
  return (
    <CardFilterControl
      compact
      value={browse.filter}
      onChange={(filter) => onChange({ filter })}
      cards={data.cards}
      groups={groups}
    />
  )
}

export function CardBrowseBar({
  data,
  browse,
  onChange,
  groups = false
}: {
  data: ShellLibrary
  browse: CardBrowse
  onChange: (change: Partial<CardBrowse>) => void
  /** Offer Groups (chats of several characters) among the filters. */
  groups?: boolean
}) {
  return (
    <div className="flex max-w-controls min-w-0 shrink-0 items-center gap-1">
      <div className="min-w-0 flex-1">
        {groups ? (
          <GroupsFilter data={data} browse={browse} onChange={onChange} />
        ) : (
          <CardFilterControl
            compact
            value={browse.filter}
            onChange={(filter) => onChange({ filter })}
            cards={data.cards}
          />
        )}
      </div>
      <CardSortControl compact sort={browse.sort} reversed={browse.reversed} onChange={onChange} />
    </div>
  )
}
