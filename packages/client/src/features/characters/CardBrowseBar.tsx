// The characters' filter and sort in one compact row, for a narrow place: the left panel's
// grid (with Groups and Include personas), Add characters (with Include personas).
// The home page lays the same parts out with CardGridControls.
import { type CardBrowse, CardFilterControl, CardSortControl, IncludePersonas } from "./cardBrowse.tsx"
import { browsable, type ShellLibrary, useGroupCount } from "./shellData.tsx"

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
      cards={browsable(data)}
      groups={groups}
      withPersonas={browse.withPersonas}
    />
  )
}

export function CardBrowseBar({
  data,
  browse,
  onChange,
  groups = false,
  includePersonas = false
}: {
  data: ShellLibrary
  browse: CardBrowse
  onChange: (change: Partial<CardBrowse>) => void
  /** Offer Groups (chats of several characters) among the filters. */
  groups?: boolean
  /** Offer Include personas at the end of the row, where the filter lists characters. */
  includePersonas?: boolean
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
            cards={browsable(data)}
            withPersonas={browse.withPersonas}
          />
        )}
      </div>
      <CardSortControl compact sort={browse.sort} reversed={browse.reversed} onChange={onChange} />
      {includePersonas && <IncludePersonas browse={browse} onChange={onChange} />}
    </div>
  )
}
